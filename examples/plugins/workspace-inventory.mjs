export default {
  id: 'official.workspace-inventory',
  version: '1.0.0',
  description: 'Read one explicitly named workspace text file.',
  tools: [{
    name: 'workspace_inventory',
    description: 'Read a bounded text file from the current workspace.',
    risk: 'read',
    readonly: true,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      if (ctx.signal?.aborted) throw Object.assign(new Error('Plugin read cancelled.'), { code: 'user_cancelled' });
      return { path: args.path, content: await ctx.workspace.readText(args.path) };
    },
  }],
};
