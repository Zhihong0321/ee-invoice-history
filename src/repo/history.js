'use strict';

/**
 * Invoice audit history reader.
 *
 * Lifted from E:\Solar Calculator v2\src\modules\Invoicing\services\invoiceHistoryRepo.js
 * with no behavior change. The repo unions rows from `invoice_audit_log` and
 * the legacy `invoice_edit_history` table, normalizes them, and sorts by
 * `edited_at DESC`.
 *
 * The `tableCache` module-level state is preserved — it speeds up repeated
 * reads in long-running processes and the keys are stable.
 */

const tableCache = new Map();

function normalizeTrimmed(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
}

async function hasTable(client, tableName) {
    if (tableCache.has(tableName)) {
        return tableCache.get(tableName);
    }

    const result = await client.query(
        `SELECT 1
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = $1
          LIMIT 1`,
        [tableName]
    );

    const exists = result.rows.length > 0;
    tableCache.set(tableName, exists);
    return exists;
}

async function getTableColumns(client, tableName) {
    const cacheKey = `${tableName}:columns`;
    if (tableCache.has(cacheKey)) {
        return tableCache.get(cacheKey);
    }

    const result = await client.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1`,
        [tableName]
    );

    const columns = new Set(result.rows.map((row) => row.column_name));
    tableCache.set(cacheKey, columns);
    return columns;
}

async function resolveInvoiceFamilyIds(client, bubbleId) {
    const invoiceResult = await client.query(
        `SELECT bubble_id, root_id, parent_id
           FROM invoice
          WHERE bubble_id = $1
             OR id::text = $1
          LIMIT 1`,
        [bubbleId]
    );

    const invoice = invoiceResult.rows[0];
    if (!invoice) {
        return {
            currentInvoiceId: null,
            familyIds: [],
            itemIds: []
        };
    }

    const anchors = [
        normalizeTrimmed(invoice.bubble_id),
        normalizeTrimmed(invoice.root_id),
        normalizeTrimmed(invoice.parent_id)
    ].filter(Boolean);

    const familyResult = anchors.length > 0
        ? await client.query(
            `SELECT DISTINCT bubble_id
               FROM invoice
              WHERE bubble_id = ANY($1::text[])
                 OR root_id = ANY($1::text[])
                 OR parent_id = ANY($1::text[])`,
            [anchors]
        )
        : { rows: [{ bubble_id: invoice.bubble_id }] };

    const familyIds = [...new Set(
        familyResult.rows
            .map((row) => normalizeTrimmed(row.bubble_id))
            .filter(Boolean)
    )];

    const itemResult = familyIds.length > 0
        ? await client.query(
            `SELECT bubble_id
               FROM invoice_item
              WHERE linked_invoice::text = ANY($1::text[])`,
            [familyIds]
        )
        : { rows: [] };

    return {
        currentInvoiceId: invoice.bubble_id,
        familyIds,
        itemIds: [...new Set(
            itemResult.rows
                .map((row) => normalizeTrimmed(row.bubble_id))
                .filter(Boolean)
        )]
    };
}

function buildAuditWhereClause(columns, alias, familyIds, itemIds) {
    const conditions = [];
    const values = [];

    const pushValues = (items) => {
        values.push(items);
        return `$${values.length}::text[]`;
    };

    const familyPlaceholder = familyIds.length > 0 ? pushValues(familyIds) : null;

    [
        'invoice_id',
        'invoice_bubble_id',
        'linked_invoice',
        'root_invoice_id',
        'parent_invoice_id',
        'invoice_ref',
        'linked_invoice_id'
    ].forEach((column) => {
        if (columns.has(column) && familyPlaceholder) {
            conditions.push(`${alias}.${column}::text = ANY(${familyPlaceholder})`);
        }
    });

    if (columns.has('entity_id')) {
        if (columns.has('entity_type')) {
            if (familyPlaceholder) {
                conditions.push(`(${alias}.entity_type = 'invoice' AND ${alias}.entity_id::text = ANY(${familyPlaceholder}))`);
            }

            if (itemIds.length > 0) {
                const itemPlaceholder = pushValues(itemIds);
                conditions.push(`(${alias}.entity_type = 'invoice_item' AND ${alias}.entity_id::text = ANY(${itemPlaceholder}))`);
            }
        } else {
            const combinedIds = [...new Set([...familyIds, ...itemIds])];
            if (combinedIds.length > 0) {
                const combinedPlaceholder = pushValues(combinedIds);
                conditions.push(`${alias}.entity_id::text = ANY(${combinedPlaceholder})`);
            }
        }
    }

    return {
        conditions,
        values
    };
}

async function readHistoryRowsFromTable(client, tableName, familyIds, itemIds) {
    if (!await hasTable(client, tableName)) {
        return [];
    }

    const columns = await getTableColumns(client, tableName);
    const { conditions: whereConditions, values } = buildAuditWhereClause(columns, 'audit', familyIds, itemIds);
    if (whereConditions.length === 0) {
        return [];
    }

    const orderColumn = [
        'edited_at',
        'created_at',
        'changed_at',
        'updated_at'
    ].find((column) => columns.has(column));

    const rawResult = await client.query(
        `SELECT audit.*
           FROM ${tableName} audit
          WHERE ${whereConditions.join(' OR ')}
          ${orderColumn ? `ORDER BY audit.${orderColumn} DESC` : ''}`,
        values
    );

    return rawResult.rows.map((row) => ({
        ...row,
        __source_table: tableName
    }));
}

function pickFirstValue(row, fields) {
    for (const field of fields) {
        if (row[field] !== null && row[field] !== undefined && String(row[field]).trim() !== '') {
            return row[field];
        }
    }
    return null;
}

function normalizeActionType(rawAction) {
    const value = String(rawAction || '').trim().toUpperCase();
    if (!value) return 'UPDATED';
    if (['INSERT', 'CREATE', 'CREATED', 'ADD', 'ADDED'].includes(value)) return 'ADDED';
    if (['DELETE', 'DELETED', 'REMOVE', 'REMOVED'].includes(value)) return 'DELETED';
    return 'UPDATED';
}

function normalizeEntityType(rawEntity) {
    const value = normalizeTrimmed(rawEntity);
    if (!value) return 'invoice';
    return value.toLowerCase();
}

function safeParseJson(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value;

    try {
        return JSON.parse(value);
    } catch (err) {
        return null;
    }
}

function stringifyValue(value) {
    if (value === null || value === undefined || value === '') return 'Empty';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        return value.length > 0 ? value.map((item) => stringifyValue(item)).join(', ') : 'Empty';
    }

    try {
        return JSON.stringify(value);
    } catch (err) {
        return String(value);
    }
}

function normalizeChanges(rawRow) {
    const rawChanges = pickFirstValue(rawRow, ['changes', 'change_set', 'change_data', 'changed_fields']);
    const parsed = safeParseJson(rawChanges);

    if (Array.isArray(parsed)) {
        return parsed.map((change) => ({
            field: normalizeTrimmed(change?.field || change?.name || change?.column || change?.path) || 'Updated value',
            before: stringifyValue(change?.before ?? change?.old ?? change?.from ?? null),
            after: stringifyValue(change?.after ?? change?.new ?? change?.to ?? null)
        }));
    }

    if (parsed && typeof parsed === 'object') {
        return Object.entries(parsed).map(([field, value]) => ({
            field,
            before: stringifyValue(value?.before ?? value?.old ?? value?.from ?? null),
            after: stringifyValue(value?.after ?? value?.new ?? value?.to ?? value)
        }));
    }

    const beforeValue = pickFirstValue(rawRow, ['before_value', 'old_value']);
    const afterValue = pickFirstValue(rawRow, ['after_value', 'new_value']);
    const fieldValue = pickFirstValue(rawRow, ['field_name', 'column_name']);

    if (fieldValue || beforeValue !== null || afterValue !== null) {
        return [{
            field: normalizeTrimmed(fieldValue) || 'Updated value',
            before: stringifyValue(beforeValue),
            after: stringifyValue(afterValue)
        }];
    }

    return [];
}

function buildUnknownActorLabel(rawRow) {
    return normalizeTrimmed(
        pickFirstValue(rawRow, [
            'source_app',
            'application_name',
            'database_user',
            'db_user',
            'session_user_name'
        ])
    ) || 'Unknown writer';
}

function buildUnknownActorPhone(rawRow) {
    const ipAddress = normalizeTrimmed(
        pickFirstValue(rawRow, ['client_ip', 'ip_address', 'remote_addr', 'client_addr'])
    );

    return ipAddress ? `IP ${ipAddress}` : null;
}

function buildHistorySummary(actionType, entityType, changes) {
    const target = entityType.replace(/_/g, ' ');
    if (changes.length === 0) {
        return `${actionType} ${target}`;
    }

    if (changes.length === 1) {
        return `${actionType} ${target} ${changes[0].field}`;
    }

    return `${actionType} ${target} (${changes.length} changes)`;
}

function normalizeHistoryRow(rawRow) {
    const actionType = normalizeActionType(
        pickFirstValue(rawRow, ['action_type', 'change_operation', 'operation', 'event_type'])
    );
    const entityType = normalizeEntityType(
        pickFirstValue(rawRow, ['entity_type', 'table_name', 'record_type'])
    );
    const changes = normalizeChanges(rawRow);
    const editedAt = pickFirstValue(rawRow, ['edited_at', 'created_at', 'changed_at', 'updated_at']);

    const actorName = normalizeTrimmed(
        pickFirstValue(rawRow, ['edited_by_name', 'actor_name', 'user_name'])
    );
    const actorPhone = normalizeTrimmed(
        pickFirstValue(rawRow, ['edited_by_phone', 'actor_phone', 'user_phone'])
    );
    const actorRole = normalizeTrimmed(
        pickFirstValue(rawRow, ['edited_by_role', 'actor_role', 'user_role'])
    );

    const isKnownSource = Boolean(actorName || actorPhone);
    const effectiveActorName = actorName || actorPhone || buildUnknownActorLabel(rawRow);
    const effectiveActorPhone = actorPhone || (!isKnownSource ? buildUnknownActorPhone(rawRow) : null);

    return {
        action_type: actionType,
        entity_type: entityType,
        changes,
        edited_by_name: effectiveActorName,
        edited_by_phone: effectiveActorPhone,
        edited_by_role: actorRole || (!isKnownSource ? 'unknown source' : null),
        edited_at: editedAt,
        created_at: editedAt,
        source_app: normalizeTrimmed(rawRow.source_app),
        application_name: normalizeTrimmed(rawRow.application_name),
        database_user: normalizeTrimmed(rawRow.database_user || rawRow.db_user || rawRow.session_user_name),
        client_ip: normalizeTrimmed(rawRow.client_ip || rawRow.ip_address || rawRow.remote_addr || rawRow.client_addr),
        is_unknown_source: !isKnownSource,
        details: {
            description: buildHistorySummary(actionType, entityType, changes)
        }
    };
}

async function loadInvoiceHistory(client, bubbleId) {
    const { currentInvoiceId, familyIds, itemIds } = await resolveInvoiceFamilyIds(client, bubbleId);
    if (!currentInvoiceId) {
        return null;
    }

    const auditRows = await readHistoryRowsFromTable(client, 'invoice_audit_log', familyIds, itemIds);
    const legacyRows = await readHistoryRowsFromTable(client, 'invoice_edit_history', familyIds, itemIds);

    const normalizedRows = [...auditRows, ...legacyRows]
        .map(normalizeHistoryRow)
        .filter((row) => row.edited_at)
        .sort((left, right) => new Date(right.edited_at) - new Date(left.edited_at));

    return {
        invoiceId: currentInvoiceId,
        rows: normalizedRows
    };
}

module.exports = {
    loadInvoiceHistory
};
