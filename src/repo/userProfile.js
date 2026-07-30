'use strict';

/**
 * User Profile Repository
 * Handles loading user profile data including profile pictures
 */

const USER_COLUMNS = `
            id,
            bubble_id,
            name,
            contact,
            email,
            profile_picture,
            agent_code,
            main_department,
            agent_type`;

/**
 * Load user profile by user id.
 *
 * `actor_user_id` in the audit log is a Bubble id ("1739157684995x6348..."),
 * not the integer PK, so match on bubble_id first. A plain integer is only
 * tried against `id` when it actually fits in int4 — anything larger used to
 * blow up the query with "value out of range for type integer".
 *
 * @param {object} client - pg client
 * @param {string|number} userId - Bubble id or integer id
 * @returns {Promise<object|null>} - User profile or null if not found
 */
async function loadUserProfile(client, userId) {
    const key = String(userId === null || userId === undefined ? '' : userId).trim();
    if (!key) return null;

    const fitsInt4 = /^\d+$/.test(key) && Number(key) <= 2147483647;
    const sql = `
        SELECT ${USER_COLUMNS}
        FROM "user"
        WHERE bubble_id = $1${fitsInt4 ? ' OR id = $1::int' : ''}
        LIMIT 1
    `;

    const result = await client.query(sql, [key]);
    return result.rows[0] || null;
}

/**
 * Load user profile by name or email.
 *
 * Plenty of audit rows put an email in `actor_name` (the SEDA form writes the
 * submitter's login), so matching `name` alone 404s on real users.
 *
 * @param {object} client - pg client
 * @param {string} name - User name or email
 * @returns {Promise<object|null>} - User profile or null if not found
 */
async function loadUserProfileByName(client, name) {
    const sql = `
        SELECT ${USER_COLUMNS}
        FROM "user"
        WHERE LOWER(name) = LOWER($1)
           OR LOWER(email) = LOWER($1)
        LIMIT 1
    `;

    const result = await client.query(sql, [name]);
    return result.rows[0] || null;
}

/**
 * Load multiple user profiles by IDs (batch loading for efficiency)
 * @param {object} client - pg client
 * @param {number[]} userIds - Array of user IDs
 * @returns {Promise<object>} - Map of userId -> profile
 */
async function loadUserProfiles(client, userIds) {
    if (!userIds || userIds.length === 0) {
        return {};
    }

    const sql = `
        SELECT
            id,
            name,
            contact,
            email,
            profile_picture,
            agent_code,
            main_department,
            agent_type
        FROM "user"
        WHERE id = ANY($1)
    `;

    const result = await client.query(sql, [userIds]);

    // Convert to map for fast lookup
    const profileMap = {};
    result.rows.forEach(user => {
        profileMap[user.id] = user;
    });

    return profileMap;
}

/**
 * Every user, for the client-side pre-cache.
 *
 * Deliberately NOT filtered to users with a profile picture: the 79 users
 * without one were missing from the cache, so every card they appeared on
 * fired two failing lookups, on every render and every auto-refresh.
 *
 * @param {object} client - pg client
 * @returns {Promise<Array>} - Array of user profiles
 */
async function loadAllUserProfiles(client) {
    const sql = `
        SELECT ${USER_COLUMNS}
        FROM "user"
        ORDER BY name
    `;

    const result = await client.query(sql);
    return result.rows;
}

module.exports = {
    loadUserProfile,
    loadUserProfileByName,
    loadUserProfiles,
    loadAllUserProfiles
};
