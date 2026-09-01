export default {
  id: 'replace-me',
  version: '1.0.0',
  description: 'A short description of the plugin.',
  tools: [
    {
      name: 'replace_me',
      description: 'Describe one bounded operation.',
      risk: 'read',
      readonly: true,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async handler(_args, ctx) {
        if (ctx.signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'user_cancelled' });
        return { ok: true };
      },
    },
  ],
};
