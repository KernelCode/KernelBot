import { XApi } from '../services/x-api.js';
import { getLogger } from '../utils/logger.js';

/**
 * Get a configured X API client from the tool context.
 */
function getClient(context) {
  const cfg = context.config.x;
  if (!cfg?.consumer_key || !cfg?.consumer_secret || !cfg?.access_token || !cfg?.access_token_secret) {
    throw new Error('X (Twitter) not connected. Use /x link to connect your account.');
  }
  return new XApi({
    consumerKey: cfg.consumer_key,
    consumerSecret: cfg.consumer_secret,
    accessToken: cfg.access_token,
    accessTokenSecret: cfg.access_token_secret,
  });
}

function handle403(err) {
  if (err.response?.status === 403) {
    return { error: 'Access denied (403). Your X Access Token may be Read-only. Go to the X Developer Portal → App Settings → change permissions to "Read and Write", then regenerate your Access Token.' };
  }
  return null;
}

export const definitions = [
  {
    name: 'x_post_tweet',
    description: 'Post a new tweet on X (Twitter).',
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The tweet text (max 280 characters)',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'x_reply_to_tweet',
    description: 'Reply to an existing tweet on X (Twitter).',
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The reply text',
        },
        reply_to_id: {
          type: 'string',
          description: 'The tweet ID to reply to',
        },
      },
      required: ['text', 'reply_to_id'],
    },
  },
  {
    name: 'x_get_my_tweets',
    description: 'Get the authenticated user\'s recent tweets on X (Twitter).',
    input_schema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of tweets to fetch (default 10, max 100)',
        },
      },
    },
  },
  {
    name: 'x_get_tweet',
    description: 'Get a specific tweet by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        tweet_id: {
          type: 'string',
          description: 'The tweet ID',
        },
      },
      required: ['tweet_id'],
    },
  },
  {
    name: 'x_search_tweets',
    description: 'Search recent tweets on X (Twitter). Returns tweets from the last 7 days.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (supports X search operators)',
        },
        count: {
          type: 'number',
          description: 'Number of results (default 10, max 100)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'x_like_tweet',
    description: 'Like a tweet on X (Twitter).',
    input_schema: {
      type: 'object',
      properties: {
        tweet_id: {
          type: 'string',
          description: 'The tweet ID to like',
        },
      },
      required: ['tweet_id'],
    },
  },
  {
    name: 'x_retweet',
    description: 'Retweet a tweet on X (Twitter).',
    input_schema: {
      type: 'object',
      properties: {
        tweet_id: {
          type: 'string',
          description: 'The tweet ID to retweet',
        },
      },
      required: ['tweet_id'],
    },
  },
  {
    name: 'x_delete_tweet',
    description: 'Delete one of your own tweets on X (Twitter).',
    input_schema: {
      type: 'object',
      properties: {
        tweet_id: {
          type: 'string',
          description: 'The tweet ID to delete',
        },
      },
      required: ['tweet_id'],
    },
  },
  {
    name: 'x_get_profile',
    description: 'Get the authenticated X (Twitter) profile info.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

export const handlers = {
  x_post_tweet: async (params, context) => {
    try {
      const client = getClient(context);
      const tweet = await client.postTweet(params.text);
      return { success: true, message: 'Tweet posted', tweet };
    } catch (err) {
      getLogger().error(`x_post_tweet failed: ${err.message}`);
      return handle403(err) || { error: err.response?.data?.detail || err.message };
    }
  },

  x_reply_to_tweet: async (params, context) => {
    try {
      const client = getClient(context);
      const tweet = await client.replyToTweet(params.text, params.reply_to_id);
      return { success: true, message: 'Reply posted', tweet };
    } catch (err) {
      getLogger().error(`x_reply_to_tweet failed: ${err.message}`);
      return handle403(err) || { error: err.response?.data?.detail || err.message };
    }
  },

  x_get_my_tweets: async (params, context) => {
    try {
      const client = getClient(context);
      const tweets = await client.getMyTweets(params.count || 10);
      return { tweets, count: tweets.length };
    } catch (err) {
      getLogger().error(`x_get_my_tweets failed: ${err.message}`);
      return { error: err.response?.data?.detail || err.message };
    }
  },

  x_get_tweet: async (params, context) => {
    try {
      const client = getClient(context);
      const tweet = await client.getTweet(params.tweet_id);
      return { tweet };
    } catch (err) {
      getLogger().error(`x_get_tweet failed: ${err.message}`);
      return { error: err.response?.data?.detail || err.message };
    }
  },

  x_search_tweets: async (params, context) => {
    try {
      const client = getClient(context);
      const tweets = await client.searchRecentTweets(params.query, params.count || 10);
      return { tweets, count: tweets.length, query: params.query };
    } catch (err) {
      getLogger().error(`x_search_tweets failed: ${err.message}`);
      return { error: err.response?.data?.detail || err.message };
    }
  },

  x_like_tweet: async (params, context) => {
    try {
      const client = getClient(context);
      const result = await client.likeTweet(params.tweet_id);
      return { success: true, message: 'Tweet liked', result };
    } catch (err) {
      getLogger().error(`x_like_tweet failed: ${err.message}`);
      return handle403(err) || { error: err.response?.data?.detail || err.message };
    }
  },

  x_retweet: async (params, context) => {
    try {
      const client = getClient(context);
      const result = await client.retweet(params.tweet_id);
      return { success: true, message: 'Retweeted', result };
    } catch (err) {
      getLogger().error(`x_retweet failed: ${err.message}`);
      return handle403(err) || { error: err.response?.data?.detail || err.message };
    }
  },

  x_delete_tweet: async (params, context) => {
    try {
      const client = getClient(context);
      const result = await client.deleteTweet(params.tweet_id);
      return { success: true, message: 'Tweet deleted', result };
    } catch (err) {
      getLogger().error(`x_delete_tweet failed: ${err.message}`);
      return handle403(err) || { error: err.response?.data?.detail || err.message };
    }
  },

  x_get_profile: async (params, context) => {
    try {
      const client = getClient(context);
      const profile = await client.getMe();
      return { profile };
    } catch (err) {
      getLogger().error(`x_get_profile failed: ${err.message}`);
      return { error: err.response?.data?.detail || err.message };
    }
  },
};
