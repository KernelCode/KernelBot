import axios from 'axios';
import { getLogger } from '../utils/logger.js';

/**
 * LinkedIn REST API v2 client.
 * Wraps common endpoints for posts, comments, likes, and profile.
 */
export class LinkedInAPI {
  constructor(accessToken) {
    this.client = axios.create({
      baseURL: 'https://api.linkedin.com',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'LinkedIn-Version': '202502',
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    // Retry with backoff on 429
    this.client.interceptors.response.use(null, async (error) => {
      const config = error.config;
      if (error.response?.status === 429 && !config._retried) {
        config._retried = true;
        const retryAfter = parseInt(error.response.headers['retry-after'] || '5', 10);
        getLogger().warn(`[LinkedIn API] Rate limited, retrying after ${retryAfter}s`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        return this.client(config);
      }
      return Promise.reject(error);
    });
  }

  /**
   * Get the authenticated user's profile.
   */
  async getProfile() {
    const { data } = await this.client.get('/v2/userinfo');
    return data;
  }

  /**
   * Create a text-only post.
   * @param {string} authorUrn - e.g. "urn:li:person:XXXXX"
   * @param {string} text - Post content
   * @param {string} visibility - "PUBLIC" or "CONNECTIONS"
   */
  async createTextPost(authorUrn, text, visibility = 'PUBLIC') {
    const body = {
      author: authorUrn,
      commentary: text,
      visibility,
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
    };

    const { data } = await this.client.post('/rest/posts', body);
    return data;
  }

  /**
   * Create a post with an article link.
   * @param {string} authorUrn
   * @param {string} text - Commentary text
   * @param {string} articleUrl - URL to share
   * @param {string} title - Article title
   */
  async createArticlePost(authorUrn, text, articleUrl, title = '') {
    const body = {
      author: authorUrn,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: {
        article: {
          source: articleUrl,
          title: title || articleUrl,
        },
      },
      lifecycleState: 'PUBLISHED',
    };

    const { data } = await this.client.post('/rest/posts', body);
    return data;
  }

  /**
   * Get the user's recent posts.
   * @param {string} authorUrn
   * @param {number} count
   */
  async getMyPosts(authorUrn, count = 10) {
    const { data } = await this.client.get('/rest/posts', {
      params: {
        q: 'author',
        author: authorUrn,
        count,
        sortBy: 'LAST_MODIFIED',
      },
    });
    return data.elements || [];
  }

  /**
   * Get a specific post by URN.
   * @param {string} postUrn
   */
  async getPost(postUrn) {
    const encoded = encodeURIComponent(postUrn);
    const { data } = await this.client.get(`/rest/posts/${encoded}`);
    return data;
  }

  /**
   * Delete a post.
   * @param {string} postUrn
   */
  async deletePost(postUrn) {
    const encoded = encodeURIComponent(postUrn);
    await this.client.delete(`/rest/posts/${encoded}`);
    return { success: true };
  }

  /**
   * Add a comment to a post.
   * @param {string} postUrn
   * @param {string} text
   * @param {string} actorUrn
   */
  async addComment(postUrn, text, actorUrn) {
    const encoded = encodeURIComponent(postUrn);
    const { data } = await this.client.post(`/rest/socialActions/${encoded}/comments`, {
      actor: actorUrn,
      message: { text },
    });
    return data;
  }

  /**
   * Get comments on a post.
   * @param {string} postUrn
   * @param {number} count
   */
  async getComments(postUrn, count = 10) {
    const encoded = encodeURIComponent(postUrn);
    const { data } = await this.client.get(`/rest/socialActions/${encoded}/comments`, {
      params: { count },
    });
    return data.elements || [];
  }

  /**
   * Like a post.
   * @param {string} postUrn
   * @param {string} actorUrn
   */
  async likePost(postUrn, actorUrn) {
    const encoded = encodeURIComponent(postUrn);
    const { data } = await this.client.post(`/rest/socialActions/${encoded}/likes`, {
      actor: actorUrn,
    });
    return data;
  }
}
