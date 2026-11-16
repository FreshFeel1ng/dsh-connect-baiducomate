/**
 * The `comate` row's Config schema.
 *
 * dsh derives the configuration form in Settings → Plugins from this schema, so
 * every field a user can fill in there is declared here. Two markers matter:
 *
 * - `volatile()` — editable while dsh runs. The loader hands the plugin a live
 *   reference and a save applies to the next request, with no restart.
 * - `role('secret')` — a credential. Read-backs and the form's own describe call
 *   never carry it; a blank field means "keep what is stored".
 *
 * Fields that are not listed stay settable in `cordis.patch.yml` (`.loose()`
 * keeps them through a save); only the ones below appear in the UI.
 */

import z from '@deepseek-ai/schemastery';

/** One volatile string field: editable at runtime, stored in the profile patch. */
function field(description, fallback = '') {
  return z.string().description(description).default(fallback).volatile();
}

export const Config = z
  .object({
    apiHost: field('Comate 私有部署地址，例如 http://192.168.1.10:9359（末尾不要带 /）'),
    license: z
      .string()
      .role('secret')
      .description('Comate license（账号凭证）。留空则回退到 COMATE_LICENSE 或 ~/.comate/cli-login.json')
      .default('')
      .volatile(),
    displayName: field('模型选择器里显示的提供方名称', 'Comate'),
    modelKey: field('model 选 auto 时实际使用的 Comate 模型 ID', 'auto'),
    workspacePath: field('兜底工作目录；dsh 会优先使用会话自己的工作区'),
    emitReasoning: z.boolean().description('是否把 Comate 的推理内容作为推理块透出').default(false).volatile(),
    forwardTools: z.boolean().description('把 dsh 独有的工具（MCP、job_*、schedule_* 等）目录转发给 Comate').default(true).volatile(),
    uploadImages: z.boolean().description('允许图片输入；关闭后带图请求会被拒绝').default(true).volatile(),
  })
  .loose();

export default Config;
