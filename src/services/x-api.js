import axios from 'axios';
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';
import { getLogger } from '../utils/logger.js';

/**
 * X (Twitter) API v2 client with OAuth 1.0a request signing.
 */
export class XApi {
  constructor({ consumerKey, consumerSecret, accessToken, accessTokenSecret }) {
    this._userId = null;

    this.oauth = OAuth({
      consumer: { key: consumerKey, secret: consumerSecret },
      signature_method: 'HMAC-SHA1',
      hash_function(baseString, key) {
        return crypto.createHmac('sha1', key).update(baseString).digest('base64');
      },
    });

    this.token = { key: accessToken, secret: accessTokenSecret };

    this.client = axios.create({
      baseURL: 'https://api.twitter.com',
      timeout: 30000,
    });

    // Sign every request with OAuth 1.0a
    this.client.interceptors.request.use((config) => {
      const url = `${config.baseURL}${config.url}`;
      const authHeader = this.oauth.toHeader(
        this.oauth.authorize({ url, method: config.method.toUpperCase() }, this.token),
      );
      config.headers = { ...config.headers, ...authHeader, 'Content-Type': 'application/json' };
      return config;
    });

    // Retry with backoff on 429
    this.client.interceptors.response.use(null, async (error) => {
      const config = error.config;
      if (error.response?.status === 429 && !config._retried) {
        config._retried = true;
        const retryAfter = parseInt(error.response.headers['retry-after'] || '5', 10);
        getLogger().warn(`[X API] Rate limited, retrying after ${retryAfter}s`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        return this.client(config);
      }
      return Promise.reject(error);
    });
  }

  /** Resolve and cache the authenticated user's ID. */
  async _getUserId() {
    if (this._userId) return this._userId;
    const me = await this.getMe();
    this._userId = me.id;
    return this._userId;
  }

  /** GET /2/users/me */
  async getMe() {
    const { data } = await this.client.get('/2/users/me', {
      params: { 'user.fields': 'id,name,username,description,public_metrics' },
    });
    if (data.data) {
      this._userId = data.data.id;
    }
    return data.data;
  }

  /** POST /2/tweets — create a new tweet */
  async postTweet(text) {
    const { data } = await this.client.post('/2/tweets', { text });
    return data.data;
  }

  /** POST /2/tweets — reply to an existing tweet */
  async replyToTweet(text, replyToId) {
    const { data } = await this.client.post('/2/tweets', {
      text,
      reply: { in_reply_to_tweet_id: replyToId },
    });
    return data.data;
  }

  /** GET /2/tweets/:id */
  async getTweet(tweetId) {
    const { data } = await this.client.get(`/2/tweets/${tweetId}`, {
      params: { 'tweet.fields': 'id,text,author_id,created_at,public_metrics,conversation_id' },
    });
    return data.data;
  }

  /** GET /2/users/:id/tweets */
  async getMyTweets(count = 10) {
    const userId = await this._getUserId();
    const { data } = await this.client.get(`/2/users/${userId}/tweets`, {
      params: {
        max_results: Math.min(Math.max(count, 5), 100),
        'tweet.fields': 'id,text,created_at,public_metrics',
      },
    });
    return data.data || [];
  }

  /** GET /2/tweets/search/recent */
  async searchRecentTweets(query, count = 10) {
    const { data } = await this.client.get('/2/tweets/search/recent', {
      params: {
        query,
        max_results: Math.min(Math.max(count, 10), 100),
        'tweet.fields': 'id,text,author_id,created_at,public_metrics',
      },
    });
    return data.data || [];
  }

  /** DELETE /2/tweets/:id */
  async deleteTweet(tweetId) {
    const { data } = await this.client.delete(`/2/tweets/${tweetId}`);
    return data.data;
  }

  /** POST /2/users/:id/likes */
  async likeTweet(tweetId) {
    const userId = await this._getUserId();
    const { data } = await this.client.post(`/2/users/${userId}/likes`, {
      tweet_id: tweetId,
    });
    return data.data;
  }

  /** POST /2/users/:id/retweets */
  async retweet(tweetId) {
    const userId = await this._getUserId();
    const { data } = await this.client.post(`/2/users/${userId}/retweets`, {
      tweet_id: tweetId,
    });
    return data.data;
  }
}
