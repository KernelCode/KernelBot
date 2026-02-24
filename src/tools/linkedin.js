import { LinkedInAPI } from '../services/linkedin-api.js';
import { getLogger } from '../utils/logger.js';

/**
 * Get a configured LinkedIn API client from the tool context.
 * Expects context.config.linkedin.access_token and context.config.linkedin.person_urn
 * to be injected at dispatch time.
 */
function getClient(context) {
  const token = context.config.linkedin?.access_token;
  if (!token) throw new Error('LinkedIn not connected. Use /linkedin link to connect your account.');
  return new LinkedInAPI(token);
}

function getPersonUrn(context) {
  const urn = context.config.linkedin?.person_urn;
  if (!urn) throw new Error('LinkedIn person URN not available. Try /linkedin link again.');
  return urn;
}

export const definitions = [
  {
    name: 'linkedin_create_post',
    description: 'Create a LinkedIn post. Can be text-only or include an article link.',
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The post content/commentary text',
        },
        visibility: {
          type: 'string',
          enum: ['PUBLIC', 'CONNECTIONS'],
          description: 'Post visibility (default: PUBLIC)',
        },
        article_url: {
          type: 'string',
          description: 'Optional URL to share as an article attachment',
        },
        article_title: {
          type: 'string',
          description: 'Optional title for the shared article',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'linkedin_get_my_posts',
    description: 'Get the user\'s recent LinkedIn posts.',
    input_schema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of posts to fetch (default 10)',
        },
      },
    },
  },
  {
    name: 'linkedin_get_post',
    description: 'Get a specific LinkedIn post by its URN.',
    input_schema: {
      type: 'object',
      properties: {
        post_urn: {
          type: 'string',
          description: 'The LinkedIn post URN (e.g. urn:li:share:12345)',
        },
      },
      required: ['post_urn'],
    },
  },
  {
    name: 'linkedin_comment_on_post',
    description: 'Add a comment to a LinkedIn post.',
    input_schema: {
      type: 'object',
      properties: {
        post_urn: {
          type: 'string',
          description: 'The LinkedIn post URN to comment on',
        },
        comment: {
          type: 'string',
          description: 'The comment text',
        },
      },
      required: ['post_urn', 'comment'],
    },
  },
  {
    name: 'linkedin_get_comments',
    description: 'Get comments on a LinkedIn post.',
    input_schema: {
      type: 'object',
      properties: {
        post_urn: {
          type: 'string',
          description: 'The LinkedIn post URN',
        },
        count: {
          type: 'number',
          description: 'Number of comments to fetch (default 10)',
        },
      },
      required: ['post_urn'],
    },
  },
  {
    name: 'linkedin_like_post',
    description: 'Like a LinkedIn post.',
    input_schema: {
      type: 'object',
      properties: {
        post_urn: {
          type: 'string',
          description: 'The LinkedIn post URN to like',
        },
      },
      required: ['post_urn'],
    },
  },
  {
    name: 'linkedin_get_profile',
    description: 'Get the linked LinkedIn profile information.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'linkedin_delete_post',
    description: 'Delete a LinkedIn post.',
    input_schema: {
      type: 'object',
      properties: {
        post_urn: {
          type: 'string',
          description: 'The LinkedIn post URN to delete',
        },
      },
      required: ['post_urn'],
    },
  },
];

export const handlers = {
  linkedin_create_post: async (params, context) => {
    try {
      const client = getClient(context);
      const authorUrn = getPersonUrn(context);
      const visibility = params.visibility || 'PUBLIC';

      let result;
      if (params.article_url) {
        result = await client.createArticlePost(authorUrn, params.text, params.article_url, params.article_title);
      } else {
        result = await client.createTextPost(authorUrn, params.text, visibility);
      }

      return { success: true, message: 'Post created successfully', post: result };
    } catch (err) {
      getLogger().error(`linkedin_create_post failed: ${err.message}`);
      return { error: err.response?.data?.message || err.message };
    }
  },

  linkedin_get_my_posts: async (params, context) => {
    try {
      const client = getClient(context);
      const authorUrn = getPersonUrn(context);
      const posts = await client.getMyPosts(authorUrn, params.count || 10);
      return { posts, count: posts.length };
    } catch (err) {
      getLogger().error(`linkedin_get_my_posts failed: ${err.message}`);
      return { error: err.response?.data?.message || err.message };
    }
  },

  linkedin_get_post: async (params, context) => {
    try {
      const client = getClient(context);
      const post = await client.getPost(params.post_urn);
      return { post };
    } catch (err) {
      getLogger().error(`linkedin_get_post failed: ${err.message}`);
      return { error: err.response?.data?.message || err.message };
    }
  },

  linkedin_comment_on_post: async (params, context) => {
    try {
      const client = getClient(context);
      const actorUrn = getPersonUrn(context);
      const result = await client.addComment(params.post_urn, params.comment, actorUrn);
      return { success: true, message: 'Comment posted', comment: result };
    } catch (err) {
      getLogger().error(`linkedin_comment_on_post failed: ${err.message}`);
      return { error: err.response?.data?.message || err.message };
    }
  },

  linkedin_get_comments: async (params, context) => {
    try {
      const client = getClient(context);
      const comments = await client.getComments(params.post_urn, params.count || 10);
      return { comments, count: comments.length };
    } catch (err) {
      getLogger().error(`linkedin_get_comments failed: ${err.message}`);
      return { error: err.response?.data?.message || err.message };
    }
  },

  linkedin_like_post: async (params, context) => {
    try {
      const client = getClient(context);
      const actorUrn = getPersonUrn(context);
      const result = await client.likePost(params.post_urn, actorUrn);
      return { success: true, message: 'Post liked', result };
    } catch (err) {
      getLogger().error(`linkedin_like_post failed: ${err.message}`);
      return { error: err.response?.data?.message || err.message };
    }
  },

  linkedin_get_profile: async (params, context) => {
    try {
      const client = getClient(context);
      const profile = await client.getProfile();
      return { profile };
    } catch (err) {
      getLogger().error(`linkedin_get_profile failed: ${err.message}`);
      return { error: err.response?.data?.message || err.message };
    }
  },

  linkedin_delete_post: async (params, context) => {
    try {
      const client = getClient(context);
      await client.deletePost(params.post_urn);
      return { success: true, message: 'Post deleted' };
    } catch (err) {
      getLogger().error(`linkedin_delete_post failed: ${err.message}`);
      return { error: err.response?.data?.message || err.message };
    }
  },
};
