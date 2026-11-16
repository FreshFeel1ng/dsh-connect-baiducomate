'use strict';

/**
 * Comate's server toolset and dsh's toolset use different names and argument
 * conventions. This module owns every translation between them.
 */

const DEFAULT_TOOL_MAP = {
  Glob: 'glob',
  Grep: 'grep',
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  Bash: 'bash',
  RunCommand: 'bash',
  Shell: 'pwsh',
  ListDir: 'glob',
  LS: 'glob',
  WebSearch: 'web_search',
  WebFetch: 'web_fetch',
  Skill: 'skill',
  TodoWrite: 'todo_write',
  Task: 'subagent',
  ApplyPatch: 'edit',
};

const DEFAULT_ARGUMENT_ALIASES = {
  glob: { target_directory: 'path', directory: 'path', target: 'path', base_path: 'path', root: 'path' },
  grep: {
    target_directory: 'path',
    directory: 'path',
    search_path: 'path',
    query: 'pattern',
    regex: 'pattern',
    glob: 'include',
    file_pattern: 'include',
  },
  read: {
    path: 'file_path',
    target_file: 'file_path',
    file: 'file_path',
    line: 'offset',
    start_line: 'offset',
    start: 'offset',
    max_lines: 'limit',
    count: 'limit',
  },
  write: { path: 'file_path', target_file: 'file_path', text: 'content' },
  edit: { path: 'file_path', target_file: 'file_path', old: 'old_string', new: 'new_string' },
  pwsh: {
    cmd: 'command',
    script: 'command',
    cwd: 'workdir',
    directory: 'workdir',
    timeout: 'timeoutMs',
    background: 'run_in_background',
  },
  bash: {
    cmd: 'command',
    script: 'command',
    cwd: 'workdir',
    directory: 'workdir',
    timeout: 'timeoutMs',
    background: 'run_in_background',
  },
  web_search: { q: 'query' },
  web_fetch: { uri: 'url' },
};

function availableToolNames(tools) {
  const names = new Set();
  for (const tool of tools || []) {
    const name = tool?.function?.name || tool?.name;
    if (typeof name === 'string' && name) names.add(name);
  }
  return names;
}

function toolSchemas(tools) {
  const schemas = new Map();
  for (const tool of tools || []) {
    const fn = tool?.function || tool;
    if (typeof fn?.name === 'string' && fn.name) {
      schemas.set(fn.name, fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : {});
    }
  }
  return schemas;
}

function toDshToolName(serverName, available, toolMap) {
  if (available.has(serverName)) return serverName;
  const mapped = toolMap[serverName];
  const snake = String(serverName || 'tool')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  const candidates = [mapped, snake];
  if (serverName === 'Bash' || serverName === 'RunCommand' || serverName === 'Shell') {
    candidates.unshift('pwsh');
  }
  for (const candidate of candidates) {
    if (candidate && (available.size === 0 || available.has(candidate))) return candidate;
  }
  // No fallback to some other available tool: mapping an unknown Comate tool
  // onto an unrelated dsh tool ran the wrong thing with the wrong arguments.
  // An unmapped name reaches dsh as an unknown tool, which it reports back to
  // the model so the model can adapt.
  return mapped || snake;
}

/**
 * Comate streams parameter values as text, so a nested array/object frequently
 * arrives JSON-encoded inside a string. Parse it back when the schema declares
 * that shape; dsh validates client-tool arguments strictly and rejects strings.
 */
function parseJsonShaped(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed[0] !== '[' && trimmed[0] !== '{') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function coerceValue(value, property) {
  if (!property || typeof property !== 'object') return value;
  const types = Array.isArray(property.type) ? property.type : [property.type];
  if (types.includes('number') || types.includes('integer')) {
    if (value === '' || value === null || value === undefined) return undefined;
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  if (types.includes('boolean')) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    return undefined;
  }
  if (types.includes('array')) {
    if (Array.isArray(value)) return value;
    if (value === '' || value === null || value === undefined) return undefined;
    const parsed = parseJsonShaped(value);
    return Array.isArray(parsed) ? parsed : value;
  }
  if (types.includes('object')) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (value === '' || value === null || value === undefined) return undefined;
    const parsed = parseJsonShaped(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : value;
  }
  if (types.includes('string') && (typeof value === 'number' || typeof value === 'boolean')) {
    return String(value);
  }
  return value;
}

/**
 * Split on commas that are not inside a brace group, so `*.{ts,tsx}` stays one
 * glob while `*.ts,*.tsx` comes back as two.
 */
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * dsh's `grep` takes exactly ONE positive glob and rejects `!…` and top-level
 * comma lists outright. Comate's search tools speak the ripgrep dialect, where
 * both are ordinary, so translate them instead of forwarding a call that can
 * only come back as a tool error. A negated pattern has no `grep` equivalent —
 * dsh has no exclude parameter — so it is dropped and the search runs with
 * ripgrep's own ignore rules, which is the closest honest meaning.
 */
function normalizeGrepInclude(value) {
  const entries = (Array.isArray(value) ? value : [value])
    .filter((entry) => typeof entry === 'string')
    .flatMap(splitTopLevelCommas)
    .filter((entry) => !entry.startsWith('!'));
  if (entries.length === 0) return undefined;
  return entries.length === 1 ? entries[0] : `{${entries.join(',')}}`;
}

/**
 * Rename known synonyms, drop undeclared keys, coerce declared scalar types,
 * then apply the few shape repairs dsh validates strictly.
 */
function sanitizeInput(name, input, schemas, config) {
  const schema = schemas.get(name) || {};
  const properties = schema.properties;
  const aliases = {
    ...(DEFAULT_ARGUMENT_ALIASES[name] || {}),
    ...(config.argumentAliases[name] || {}),
  };
  const source = { ...(input || {}) };

  for (const [from, to] of Object.entries(aliases)) {
    if (!(to in source) && from in source) source[to] = source[from];
  }

  const result = {};
  if (!properties || typeof properties !== 'object') {
    Object.assign(result, source);
  } else {
    for (const [key, value] of Object.entries(source)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) continue;
      const coerced = coerceValue(value, properties[key]);
      if (coerced !== undefined) result[key] = coerced;
    }
  }

  if (name === 'read' && typeof result.offset === 'number' && result.offset < 1) {
    result.offset = 1;
  }
  if (name === 'glob' && (!result.pattern || result.pattern === '')) {
    result.pattern = '**/*';
  }
  if (name === 'grep' && 'include' in result) {
    const include = normalizeGrepInclude(result.include);
    if (include === undefined) delete result.include;
    else result.include = include;
  }
  if ((name === 'pwsh' || name === 'bash') && !result.description && result.command) {
    result.description = String(result.command).slice(0, 60);
  }
  if (name === 'pwsh' || name === 'bash') {
    const allowed = new Set(['workspace-write', 'danger-full-access']);
    if (result.sandbox_permissions !== undefined && !allowed.has(result.sandbox_permissions)) {
      delete result.sandbox_permissions;
    }
    if (result.sandbox_permissions === 'danger-full-access' && !result.justification) {
      delete result.sandbox_permissions;
    }
    if (result.sandbox_permissions === undefined) delete result.justification;
  }
  return result;
}

/** Budget for the whole catalogue block, and for one tool's schema inside it. */
const CATALOG_BUDGET = 16000;
const CATALOG_SCHEMA_CHARS = 3000;

/**
 * Strip the human copy from a schema before falling back to dropping it.
 * Descriptions are the bulk of an MCP schema and are worth less to the model
 * than the structure it needs to call the tool; the shape stays intact.
 */
function compactSchema(schema) {
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(schema || {}));
  } catch {
    return '{"type":"object"}';
  }
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    delete node.description;
    delete node.examples;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  };
  walk(clone);
  try {
    return JSON.stringify(clone);
  } catch {
    return '{"type":"object"}';
  }
}

/**
 * Render dsh-only tools as a prompt block. Comate's execute API has no `tools`
 * field, so this block travels in `contexts` and names each callable tool.
 */
function toolCatalogContext(tools, config) {
  if (!config.forwardTools || !Array.isArray(tools) || tools.length === 0) return '';
  const builtin = new Set(Object.values(config.toolMap));
  const candidates = [];
  for (const tool of tools) {
    const fn = tool?.function || tool;
    const name = fn?.name;
    if (typeof name !== 'string' || !name) continue;
    const isBuiltin = builtin.has(name);
    if (isBuiltin && !config.forwardAllTools) continue;
    candidates.push({ fn, name, isBuiltin });
  }
  candidates.sort((a, b) => Number(a.isBuiltin) - Number(b.isBuiltin));

  const head = [
    '<client_tools>',
    'The client executes tools on the user machine. Your built-in file, search, and shell tools remain preferred for those tasks.',
    'When the task needs a capability below, emit a tool_use whose name is exactly the listed name and whose input matches its JSON schema. Never invent a name.',
  ];
  const tail = '</client_tools>';
  let budget = CATALOG_BUDGET - head.join('\n').length - tail.length;

  const entries = [];
  let omitted = 0;
  for (const { fn, name } of candidates.slice(0, config.forwardToolLimit)) {
    const description = String(fn.description || '').replace(/\s+/g, ' ').slice(0, 300);
    let schema = '{}';
    try {
      schema = JSON.stringify(fn.parameters || {});
    } catch {
      schema = '{}';
    }
    // Whole schemas only: half a JSON document teaches the model nothing and
    // made whole tools uncallable.
    if (schema.length > CATALOG_SCHEMA_CHARS) schema = compactSchema(fn.parameters);
    if (schema.length > CATALOG_SCHEMA_CHARS) schema = '{"type":"object","description":"schema omitted for length"}';
    const entry = `- ${name}: ${description}\n  input: ${schema}`;
    if (entry.length > budget) {
      omitted += 1;
      continue;
    }
    budget -= entry.length;
    entries.push(entry);
  }
  if (entries.length === 0) return '';

  return [
    ...head,
    ...entries,
    omitted > 0 ? `- (${omitted} more tool${omitted === 1 ? '' : 's'} omitted for length)` : '',
    tail,
  ]
    .filter(Boolean)
    .join('\n');
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const ATTACHMENT_PATH = /[\\/](?:\.dsh[\\/]attachments|attachments[\\/]v1[\\/]objects)[\\/]/i;

function isImagePath(value) {
  return typeof value === 'string' && (IMAGE_EXTENSION.test(value) || ATTACHMENT_PATH.test(value));
}

function buildToolCalls(state, config) {
  const calls = [];
  let index = 0;
  for (const call of state.toolUses.values()) {
    let name = toDshToolName(call.name, state.availableTools || new Set(), config.toolMap);
    let input = sanitizeInput(name, call.input, state.toolSchemas || new Map(), config);
    if (name === 'read' && state.availableTools?.has('read_image') && isImagePath(input.file_path)) {
      name = 'read_image';
      input = sanitizeInput(name, input, state.toolSchemas || new Map(), config);
    }
    calls.push({
      index,
      id: call.id,
      type: 'function',
      function: { name, arguments: JSON.stringify(input) },
    });
    index += 1;
  }
  return calls;
}

module.exports = {
  DEFAULT_TOOL_MAP,
  DEFAULT_ARGUMENT_ALIASES,
  availableToolNames,
  toolSchemas,
  toDshToolName,
  sanitizeInput,
  toolCatalogContext,
  isImagePath,
  buildToolCalls,
};
