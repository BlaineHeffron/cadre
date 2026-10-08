import { createRequire } from 'node:module';

// Resolve through Fastify's compiler so its bundled Ajv also works without hoisting.
const require = createRequire(import.meta.url);
const Ajv = createRequire(require.resolve('@fastify/ajv-compiler'))('ajv');
const ajv = new Ajv({ strict: false, allErrors: true });

function omitOptionalNulls(schema, args) {
  if (!args || typeof args !== 'object') return;
  if (Array.isArray(args)) {
    for (const item of args) omitOptionalNulls(schema?.items, item);
    return;
  }
  for (const [key, property] of Object.entries(schema?.properties || {})) {
    if (args[key] === null && !schema.required?.includes(key)) delete args[key];
    else omitOptionalNulls(property, args[key]);
  }
}

export function compileToolArguments(tools) {
  const validators = new Map(tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));
  return (name, args) => {
    const validate = validators.get(name);
    if (!validate) return;
    omitOptionalNulls(validate.schema, args);
    if (validate(args)) return;
    // Prefer unknown keys over missing ones to point callers at misspellings.
    const error = validate.errors.find((entry) => entry.keyword === 'additionalProperties') || validate.errors[0];
    const path = error.instancePath.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')).join('.');
    const argument = [path, error.params.additionalProperty || error.params.missingProperty].filter(Boolean).join('.') || 'arguments';
    const schema = error.instancePath.split('/').slice(1).reduce((schema, key) => schema?.properties?.[key] || schema?.items, tools.find((tool) => tool.name === name).inputSchema);
    const detail = error.keyword === 'additionalProperties'
      ? `unknown argument "${argument}"; expected: ${Object.keys(schema?.properties || {}).join(', ') || '(none)'}`
      : error.keyword === 'required' ? `missing required argument "${argument}"`
      : `argument "${argument}" ${error.message}${error.keyword === 'enum' ? `: ${error.params.allowedValues.join(', ')}` : ''}`;
    const failure = new Error(`${name}: ${detail}`);
    failure.code = 'mcp_invalid_arguments';
    failure.statusCode = 400;
    throw failure;
  };
}
