export const definitions = [
  {
    name: 'update_user_persona',
    description:
      'Update the stored persona/profile for the current user. ' +
      'Pass the COMPLETE updated persona document as markdown. ' +
      'Before calling this, mentally merge any new information into the existing persona — ' +
      'do not blindly append. Only call when you discover genuinely new, meaningful information ' +
      '(expertise, preferences, projects, communication style).',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The full updated persona markdown document.',
        },
      },
      required: ['content'],
    },
  },
];

export const handlers = {
  async update_user_persona({ content }, context) {
    const { personaManager, user } = context;
    if (!personaManager) return { error: 'Persona manager not available.' };
    if (!user?.id) return { error: 'User ID not available.' };

    personaManager.save(user.id, content);
    return { success: true, message: 'User persona updated.' };
  },
};
