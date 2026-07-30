/**
 * User Profile Cache
 * Client-side caching layer for user profile pictures and metadata
 */

class UserProfileCache {
  constructor() {
    this.cache = new Map();
    this.loading = new Set();
    this.initialized = false;
  }

  /**
   * Initialize cache by loading all users with profile pictures
   */
  async init() {
    if (this.initialized) return;

    try {
      const res = await fetch('/api/users/profiles-cache');
      const data = await res.json();

      if (data.ok) {
        data.profiles.forEach(profile => {
          // Audit rows reference users by integer id, Bubble id, name OR email,
          // so index every one of them up front. Anything not indexed here
          // becomes a network round-trip per card, per render.
          if (profile.id) {
            this.cache.set(`id:${profile.id}`, profile);
          }
          if (profile.bubble_id) {
            this.cache.set(`id:${profile.bubble_id}`, profile);
          }
          if (profile.name) {
            this.cache.set(`name:${profile.name.toLowerCase()}`, profile);
          }
          if (profile.email) {
            this.cache.set(`name:${profile.email.toLowerCase()}`, profile);
          }
        });

        this.initialized = true;
        console.log(`[UserProfileCache] Loaded ${data.count} user profiles`);
      }
    } catch (err) {
      console.error('[UserProfileCache] Failed to initialize:', err);
    }
  }

  /**
   * Get user profile by ID
   */
  async getByUserId(userId) {
    if (!userId) return null;

    const cacheKey = `id:${userId}`;

    // Return from cache if available
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // Prevent duplicate requests
    if (this.loading.has(cacheKey)) {
      await this._waitForLoad(cacheKey);
      return this.cache.get(cacheKey) || null;
    }

    // Fetch from API
    this.loading.add(cacheKey);
    try {
      const res = await fetch(`/api/users/profile/${userId}`);
      const data = await res.json();

      if (data.ok && data.profile) {
        this.cache.set(cacheKey, data.profile);
        if (data.profile.name) {
          this.cache.set(`name:${data.profile.name.toLowerCase()}`, data.profile);
        }
        return data.profile;
      }

      // Remember the miss. Without this every render — and every 15s
      // auto-refresh — re-requests the same unknown user.
      this.cache.set(cacheKey, null);
    } catch (err) {
      console.error(`[UserProfileCache] Failed to load user ${userId}:`, err);
      this.cache.set(cacheKey, null);
    } finally {
      this.loading.delete(cacheKey);
    }

    return null;
  }

  /**
   * Get user profile by name (fallback)
   */
  async getByName(name) {
    if (!name) return null;

    const cacheKey = `name:${name.toLowerCase()}`;

    // Return from cache if available
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // Prevent duplicate requests
    if (this.loading.has(cacheKey)) {
      await this._waitForLoad(cacheKey);
      return this.cache.get(cacheKey) || null;
    }

    // Fetch from API
    this.loading.add(cacheKey);
    try {
      const res = await fetch(`/api/users/profile-by-name/${encodeURIComponent(name)}`);
      const data = await res.json();

      if (data.ok && data.profile) {
        this.cache.set(cacheKey, data.profile);
        if (data.profile.id) {
          this.cache.set(`id:${data.profile.id}`, data.profile);
        }
        if (data.profile.bubble_id) {
          this.cache.set(`id:${data.profile.bubble_id}`, data.profile);
        }
        return data.profile;
      }

      this.cache.set(cacheKey, null);
    } catch (err) {
      console.error(`[UserProfileCache] Failed to load user by name "${name}":`, err);
      this.cache.set(cacheKey, null);
    } finally {
      this.loading.delete(cacheKey);
    }

    return null;
  }

  /**
   * Get profile picture URL for a user
   */
  async getProfilePicture(userId, userName) {
    let profile = null;

    if (userId) {
      profile = await this.getByUserId(userId);
    }

    if (!profile && userName) {
      profile = await this.getByName(userName);
    }

    return profile?.profile_picture || null;
  }

  /**
   * Get initials from name for fallback avatar
   */
  getInitials(name) {
    if (!name) return '?';

    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) {
      return parts[0].charAt(0).toUpperCase();
    }

    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  /**
   * Wait for a pending load to complete
   */
  async _waitForLoad(cacheKey, timeout = 5000) {
    const start = Date.now();
    while (this.loading.has(cacheKey)) {
      if (Date.now() - start > timeout) {
        console.warn(`[UserProfileCache] Timeout waiting for ${cacheKey}`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

// Global instance
window.userProfileCache = new UserProfileCache();
