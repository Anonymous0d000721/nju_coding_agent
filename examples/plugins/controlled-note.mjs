export default {
  id: 'official.controlled-note',
  version: '1.0.0',
  description: 'Write a bounded note through the host workspace capability.',
  tools: [{
    name: 'write_workspace_note',
    description: 'Create or replace a workspace-relative Markdown note.',
    risk: 'write',
    readonly: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', pattern: '^[^./].*\\.md$' },
        content: { type: 'string', minLength: 1 },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      if (ctx.signal?.aborted) throw Object.assign(new Error('Plugin write cancelled.'), { code: 'user_cancelled' });
      return await ctx.workspace.writeText(args.path, args.content, { createDirectories: false });
    },
  }],
};
