/**
 * Minimal `@deepseek-ai/schemastery` stand-in.
 *
 * The real package lives inside the dsh installation, so the offline tests
 * redirect the bare specifier here. Only the builders `lib/schema.mjs` calls are
 * implemented, plus `toJSON()`, which is what the settings service reads to
 * derive a form.
 */

class Schema {
  constructor(type, meta = {}, dict) {
    this.type = type;
    this.meta = meta;
    this.dict = dict;
  }

  /** Copy with one more meta key, the way schemastery chains immutable. */
  withMeta(key, value) {
    return new Schema(this.type, { ...this.meta, [key]: value }, this.dict);
  }

  description(text) {
    return this.withMeta('description', text);
  }

  default(value) {
    return this.withMeta('default', value);
  }

  role(role) {
    return this.withMeta('role', role);
  }

  extra(key, value) {
    return this.withMeta(key, value);
  }

  volatile() {
    return this.withMeta('volatile', true);
  }

  loose(value = true) {
    return this.withMeta('loose', value);
  }

  toJSON() {
    return {
      type: this.type,
      meta: { ...this.meta },
      ...(this.dict === undefined
        ? {}
        : { dict: Object.fromEntries(Object.entries(this.dict).map(([key, child]) => [key, child.toJSON()])) }),
    };
  }
}

const scalar = (type) => () => new Schema(type);

const z = {
  string: scalar('string'),
  number: scalar('number'),
  boolean: scalar('boolean'),
  any: scalar('any'),
  dict: (inner) => new Schema('dict', {}, { '*': inner }),
  object: (dict) => new Schema('object', {}, dict),
};

export default z;
export { Schema };
