import type { JsonSchema } from './types.js';

export interface ValidationResult {
  ok: boolean;
  message?: string;
}

export function validateJsonSchema(value: unknown, schema: JsonSchema, path = 'args'): ValidationResult {
  const type = schema.type;
  if (typeof type === 'string') {
    const typeResult = validateType(value, type, path);
    if (!typeResult.ok) return typeResult;
  }

  if (schema.enum && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return { ok: false, message: `${path} must be one of: ${schema.enum.join(', ')}` };
  }

  if (type === 'object' || schema.properties) {
    if (!isRecord(value)) return { ok: false, message: `${path} must be an object` };
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) return { ok: false, message: `${path}.${key} is required` };
    }

    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value && isRecord(childSchema)) {
        const result = validateJsonSchema(value[key], childSchema, `${path}.${key}`);
        if (!result.ok) return result;
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) return { ok: false, message: `${path}.${key} is not allowed` };
      }
    }
  }

  if (type === 'array') {
    if (!Array.isArray(value)) return { ok: false, message: `${path} must be an array` };
    if (isRecord(schema.items)) {
      for (let i = 0; i < value.length; i += 1) {
        const result = validateJsonSchema(value[i], schema.items, `${path}[${i}]`);
        if (!result.ok) return result;
      }
    }
  }

  return { ok: true };
}

function validateType(value: unknown, type: string, path: string): ValidationResult {
  if (type === 'array') return Array.isArray(value) ? { ok: true } : { ok: false, message: `${path} must be an array` };
  if (type === 'object') return isRecord(value) ? { ok: true } : { ok: false, message: `${path} must be an object` };
  if (type === 'integer') return Number.isInteger(value) ? { ok: true } : { ok: false, message: `${path} must be an integer` };
  if (type === 'number') return typeof value === 'number' ? { ok: true } : { ok: false, message: `${path} must be a number` };
  if (type === 'string') return typeof value === 'string' ? { ok: true } : { ok: false, message: `${path} must be a string` };
  if (type === 'boolean') return typeof value === 'boolean' ? { ok: true } : { ok: false, message: `${path} must be a boolean` };
  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}