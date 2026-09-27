// Env vars moved from the DM_/DUENO_ prefixes to CADRE_. Code keeps using the
// legacy name as the key; reads prefer CADRE_<rest>, and vars Fleet injects into
// child processes are written under both names so either reader works.
export const cadreEnvName = (name) => String(name).replace(/^(DM|DUENO)_/, 'CADRE_');

export const readEnv = (name, env = process.env) => env?.[cadreEnvName(name)] ?? env?.[name];

export const withCadreEnv = (vars) => Object.fromEntries(Object.entries(vars)
  .flatMap(([name, value]) => [[cadreEnvName(name), value], [name, value]]));
