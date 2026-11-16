/**
 * dsh-connect-baiducomate — client half.
 *
 * Puts the route's configuration in dsh itself: Settings → Plugins →
 * dsh-connect-baiducomate gets an editable form for the `comate` row, so a user
 * fills in `apiHost` and `license` here instead of hand-editing
 * `cordis.patch.yml` or digging them out of a logged-in Comate client.
 *
 * The form is not hand-rolled state: it binds the Host's own settings entry
 * through `ctx.configForms` (the same service the shipped settings pages use),
 * so the profile patch stays the single source of truth and a save reaches the
 * running adapter without a restart. Three disciplines, the ones the shipped
 * client plugins follow:
 *
 *   1. Never break the Plugins page. A missing service, a failed read, or an
 *      unknown React fails open: the form says so and the rest of the page is
 *      untouched.
 *   2. Never lie about state. Fields show the Host's accepted values, a refused
 *      save keeps the draft and says why, and a secret is never echoed back —
 *      an empty license field means "keep what is stored".
 *   3. Only theme tokens for colour (`--dsw-*`), so light and dark both work.
 */

window.__ModuleLoader__.load({
  id: 'dsh-connect-baiducomate',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');

    var PACKAGE_ID = 'dsh-connect-baiducomate';
    var ROW_ID = 'comate';
    var ROW_CONFIG_SLOT = 'plugins.row.config';
    var BUNDLE_CONFIG_SLOT = 'plugins.bundle.config';
    /** Keyed slots are dispatched by `<package name>#<row id>` (row) and package name (bundle). */
    var ROW_CONFIG_KEY = PACKAGE_ID + '#' + ROW_ID;
    var STYLE_ID = PACKAGE_ID + '-config-styles';
    var inject = ['slots'];

    var CSS = [
      '.dcbc{display:flex;flex-direction:column;gap:14px;max-width:720px;font-size:13px;line-height:1.55;',
      'color:var(--dsw-alias-label-primary)}',
      '.dcbc__lead{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dcbc__field{display:flex;flex-direction:column;gap:4px}',
      '.dcbc__label{display:flex;align-items:baseline;gap:8px;font-weight:600}',
      '.dcbc__key{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;',
      'color:var(--dsw-alias-label-tertiary);font-weight:400}',
      '.dcbc__hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dcbc__input{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:8px;padding:6px 9px;width:100%;box-sizing:border-box}',
      '.dcbc__input:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);',
      'outline-offset:1px}',
      '.dcbc__input[data-invalid="1"]{border-color:var(--dsw-alias-state-error-primary)}',
      '.dcbc__switch{display:flex;align-items:center;justify-content:space-between;gap:16px}',
      '.dcbc__switch .dcbc__label{font-weight:500}',
      '.dcbc__switch input{accent-color:var(--dsw-alias-brand-primary);margin:0;flex:none}',
      '.dcbc__actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;',
      'padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dcbc__btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 14px;font:inherit;',
      'font-size:12px;font-weight:600;cursor:pointer;border-radius:8px;border:1px solid transparent;',
      'color:rgb(255 255 255);background:var(--dsw-alias-brand-primary)}',
      '.dcbc__btn:disabled{opacity:.55;cursor:not-allowed}',
      '.dcbc__btn--quiet{color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500;',
      'box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}',
      '.dcbc__btn--quiet:hover:not(:disabled){color:var(--dsw-alias-label-primary);',
      'background:var(--dsw-alias-interactive-bg-hover)}',
      '.dcbc__error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.dcbc__saved{margin:0;font-size:12px;color:var(--dsw-alias-state-success-primary)}',
      '.dcbc__note{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
    ].join('');

    /** Inject the stylesheet once; a failure only costs polish. */
    function installStyles() {
      try {
        if (typeof document === 'undefined') return;
        var element = document.getElementById(STYLE_ID);
        if (element === null) {
          element = document.createElement('style');
          element.id = STYLE_ID;
          document.head.appendChild(element);
        }
        if (element.textContent !== CSS) element.textContent = CSS;
      } catch (error) {
        /* cosmetic only */
      }
    }

    var COPY = {
      zh: {
        title: 'Comate 连接',
        lead: '在这里填写 Comate 私有部署地址和 license 即可，不需要安装或登录 Comate 客户端。保存后下一轮对话生效，无需重启 dsh。',
        apiHost: '部署地址',
        apiHostHint: 'Comate 私有部署的地址，例如 http://192.168.1.10:9359，末尾不要带 /。',
        license: 'License',
        licenseHint: '账号凭证。留空表示沿用已保存的值（也可用 COMATE_LICENSE 环境变量）。',
        licenseStored: '已保存，留空保持不变',
        displayName: '提供方名称',
        displayNameHint: '模型选择器里显示的名字。',
        modelKey: '默认模型',
        modelKeyHint: '模型选 auto 时实际请求的 Comate 模型 ID，留 auto 由 Comate 决定。',
        workspacePath: '兜底工作目录',
        workspacePathHint: '会话没有自带工作区时使用，可留空。',
        emitReasoning: '输出推理内容',
        forwardTools: '转发 dsh 独有工具',
        forwardToolsHint: '把 MCP、job_*、schedule_* 等工具目录发给 Comate；关闭可省上下文。',
        uploadImages: '允许图片输入',
        save: '保存',
        saving: '正在保存…',
        saved: '已保存，下一轮对话生效',
        rejected: '宿主拒绝了这次修改，草稿已保留：',
        failed: '保存失败：',
        reset: '撤销改动',
        loading: '正在读取配置…',
        unavailable: '这个 profile 没有提供配置表单（需要 dsh 0.2.0-rc.2 及以上）。',
        missingHost: '还没有填部署地址',
        invalidHost: '部署地址要以 http:// 或 https:// 开头',
        configured: '已配置',
      },
      en: {
        title: 'Comate connection',
        lead: 'Fill in the Comate private deployment URL and license here — no Comate client install or login needed. A save applies to the next turn, without restarting dsh.',
        apiHost: 'Deployment URL',
        apiHostHint: 'The private deployment address, e.g. http://192.168.1.10:9359 (no trailing slash).',
        license: 'License',
        licenseHint: 'Account credential. Leave blank to keep the stored value (COMATE_LICENSE also works).',
        licenseStored: 'stored — leave blank to keep it',
        displayName: 'Provider name',
        displayNameHint: 'What the model selector calls this provider.',
        modelKey: 'Default model',
        modelKeyHint: 'The Comate model requested when the model is "auto"; keep auto to let Comate choose.',
        workspacePath: 'Fallback workspace',
        workspacePathHint: 'Used when the session carries no workspace. Optional.',
        emitReasoning: 'Emit reasoning',
        forwardTools: 'Forward dsh-only tools',
        forwardToolsHint: 'Sends the MCP, job_*, schedule_* catalogue to Comate; turn off to save context.',
        uploadImages: 'Allow image input',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved — applies to the next turn',
        rejected: 'The host refused this change; the draft is kept: ',
        failed: 'Save failed: ',
        reset: 'Discard changes',
        loading: 'Reading configuration…',
        unavailable: 'This profile exposes no configuration form (needs dsh 0.2.0-rc.2 or newer).',
        missingHost: 'No deployment URL yet',
        invalidHost: 'The deployment URL must start with http:// or https://',
        configured: 'configured',
      },
    };

    function copy() {
      var language = '';
      try {
        language = String((typeof navigator !== 'undefined' && navigator && navigator.language) || '');
      } catch (error) {
        language = '';
      }
      return language.toLowerCase().indexOf('zh') === 0 ? COPY.zh : COPY.en;
    }

    /**
     * The Host's settings service, when this composition provides it. Read
     * through `ctx.get` rather than injected: a declaration for a service
     * nobody provides would leave this plugin's fiber pending.
     */
    function readConfigForms(ctx) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          var service = ctx.get('configForms');
          if (service && typeof service.get === 'function') return service;
        }
      } catch (error) {
        /* absent in shells without ui-settings */
      }
      return null;
    }

    /** The client context, kept so the form can be resolved lazily. */
    var clientContext = null;

    /** The row's live form controller, or null when the Host does not serve the entry. */
    var rowForm = null;

    /**
     * Resolve the row's form controller, retrying until the settings service is
     * there: ui-settings may activate after this bundle, and a one-shot lookup in
     * `apply` would leave the page read-only for the rest of the session.
     */
    function resolveRowForm() {
      if (rowForm !== null) return rowForm;
      var forms = readConfigForms(clientContext);
      if (forms === null) return null;
      try {
        rowForm = forms.get(ROW_ID);
      } catch (error) {
        rowForm = null;
      }
      return rowForm;
    }

    /** String fields the form edits, in display order. */
    var TEXT_FIELDS = [
      { key: 'apiHost', label: 'apiHost', hint: 'apiHostHint', placeholder: 'http://192.168.1.10:9359', validate: validateHost },
      { key: 'license', label: 'license', hint: 'licenseHint', secret: true },
      { key: 'displayName', label: 'displayName', hint: 'displayNameHint', placeholder: 'Comate' },
      { key: 'modelKey', label: 'modelKey', hint: 'modelKeyHint', placeholder: 'auto' },
      { key: 'workspacePath', label: 'workspacePath', hint: 'workspacePathHint' },
    ];

    /** Boolean fields, rendered as switches. */
    var SWITCH_FIELDS = [
      { key: 'emitReasoning', label: 'emitReasoning' },
      { key: 'forwardTools', label: 'forwardTools', hint: 'forwardToolsHint' },
      { key: 'uploadImages', label: 'uploadImages' },
    ];

    function validateHost(value) {
      var text = String(value === undefined || value === null ? '' : value).trim();
      if (text === '') return 'missingHost';
      return /^https?:\/\//i.test(text) ? null : 'invalidHost';
    }

    /**
     * Follow the row's settings entry. The page also passes a snapshot, but a
     * snapshot prop only refreshes when the page happens to re-render, so the
     * live controller is preferred and the prop is the fallback.
     */
    function useSnapshot(fallbackState) {
      var live = resolveRowForm();
      var pair = React.useState(function () {
        if (live !== null) return live.getSnapshot();
        return fallbackState || null;
      });
      var snapshot = pair[0];
      var setSnapshot = pair[1];
      React.useEffect(function () {
        var form = resolveRowForm();
        if (form === null || typeof form.subscribe !== 'function') {
          setSnapshot(fallbackState || null);
          return undefined;
        }
        setSnapshot(form.getSnapshot());
        return form.subscribe(function () {
          setSnapshot(form.getSnapshot());
        });
      }, []);
      return snapshot;
    }

    function fieldValue(snapshot, key) {
      var value = snapshot && snapshot.value && typeof snapshot.value === 'object' ? snapshot.value : {};
      var current = value[key];
      return current === undefined || current === null ? '' : current;
    }

    /** Whether the stored user layer carries this field, which is how a redacted secret stays visible as "set". */
    function isStored(snapshot, key) {
      var user = snapshot && snapshot.user;
      return user !== null && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, key);
    }

    function Field(props) {
      var t = props.t;
      var field = props.field;
      var value = props.value;
      var invalid = props.invalid;
      var stored = props.stored;
      var onValue = props.onValue;
      var placeholder = field.secret && stored ? t.licenseStored : field.placeholder || '';
      var hint = t[field.hint] || '';
      return React.createElement(
        'div',
        { className: 'dcbc__field' },
        React.createElement(
          'label',
          { className: 'dcbc__label' },
          t[field.label],
          React.createElement('span', { className: 'dcbc__key' }, field.key),
        ),
        React.createElement('input', {
          className: 'dcbc__input',
          type: field.secret ? 'password' : 'text',
          value: value,
          placeholder: placeholder,
          spellCheck: false,
          autoComplete: 'off',
          'data-invalid': invalid ? '1' : '0',
          onChange: function (event) {
            onValue(event && event.target ? event.target.value : '');
          },
        }),
        invalid ? React.createElement('p', { className: 'dcbc__error' }, t[invalid]) : null,
        hint ? React.createElement('p', { className: 'dcbc__hint' }, hint) : null,
      );
    }

    function Switch(props) {
      var t = props.t;
      var field = props.field;
      var value = props.value;
      var onValue = props.onValue;
      var hint = field.hint ? t[field.hint] : '';
      return React.createElement(
        'div',
        { className: 'dcbc__switch' },
        React.createElement(
          'div',
          { className: 'dcbc__field' },
          React.createElement('label', { className: 'dcbc__label' }, t[field.label]),
          hint ? React.createElement('p', { className: 'dcbc__hint' }, hint) : null,
        ),
        React.createElement('input', {
          type: 'checkbox',
          checked: value === true,
          onChange: function (event) {
            onValue(event && event.target ? event.target.checked === true : false);
          },
        }),
      );
    }

    /**
     * The configuration page: staged edits, one save, and a status line that
     * only ever reports what the Host accepted.
     */
    function ConfigPage(props) {
      var t = copy();
      var snapshot = useSnapshot(props && props.form ? props.form.state : null);
      var editsPair = React.useState({});
      var edits = editsPair[0];
      var setEdits = editsPair[1];
      var statusPair = React.useState(null);
      var status = statusPair[0];
      var setStatus = statusPair[1];
      var busyPair = React.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];

      if (props && props.view === 'summary') {
        var host = fieldValue(snapshot, 'apiHost');
        return React.createElement(
          'span',
          null,
          host ? t.configured + ' · ' + String(host) : t.missingHost,
        );
      }

      var state = snapshot;
      if (state === null) {
        return React.createElement('p', { className: 'dcbc__note' }, t.loading);
      }
      if (state.status === 'unavailable') {
        return React.createElement('p', { className: 'dcbc__note' }, t.unavailable);
      }

      var edited = Object.keys(edits).length > 0;
      var values = {};
      var invalid = {};
      for (var index = 0; index < TEXT_FIELDS.length; index += 1) {
        var field = TEXT_FIELDS[index];
        values[field.key] = Object.prototype.hasOwnProperty.call(edits, field.key)
          ? edits[field.key]
          : String(fieldValue(state, field.key));
        if (field.validate) {
          // An untouched stored value is the Host's business; only a draft is validated here.
          if (Object.prototype.hasOwnProperty.call(edits, field.key)) invalid[field.key] = field.validate(values[field.key]);
        }
      }
      for (var switchIndex = 0; switchIndex < SWITCH_FIELDS.length; switchIndex += 1) {
        var switchField = SWITCH_FIELDS[switchIndex];
        values[switchField.key] = Object.prototype.hasOwnProperty.call(edits, switchField.key)
          ? edits[switchField.key]
          : fieldValue(state, switchField.key) === true;
      }
      var blocked = Object.keys(invalid).some(function (key) {
        return invalid[key] !== null && invalid[key] !== undefined;
      });

      var stage = function (key, next) {
        setStatus(null);
        setEdits(function (previous) {
          var draft = Object.assign({}, previous);
          draft[key] = next;
          return draft;
        });
      };

      var save = function () {
        if (busy || !edited || blocked) return;
        var ops = Object.keys(edits).map(function (key) {
          return { op: 'set', path: [key], value: edits[key] };
        });
        var target = resolveRowForm() || (props && props.form);
        if (!target || typeof target.mutate !== 'function') {
          setStatus({ kind: 'failed', reason: t.unavailable });
          return;
        }
        setBusy(true);
        setStatus(null);
        Promise.resolve(target.mutate(ops, state.revision))
          .then(function (accepted) {
            setBusy(false);
            if (accepted === false) {
              setStatus({ kind: 'rejected' });
              return;
            }
            setEdits({});
            setStatus({ kind: 'saved' });
          })
          .catch(function (error) {
            setBusy(false);
            setStatus({ kind: 'failed', reason: String(error && error.message ? error.message : error) });
          });
      };

      var children = [
        React.createElement('p', { className: 'dcbc__lead', key: 'lead' }, t.lead),
      ];
      for (var textIndex = 0; textIndex < TEXT_FIELDS.length; textIndex += 1) {
        var textField = TEXT_FIELDS[textIndex];
        children.push(
          React.createElement(Field, {
            key: textField.key,
            t: t,
            field: textField,
            value: values[textField.key],
            invalid: invalid[textField.key],
            stored: isStored(state, textField.key),
            onValue: function (key) {
              return function (next) {
                stage(key, next);
              };
            }(textField.key),
          }),
        );
      }
      for (var toggleIndex = 0; toggleIndex < SWITCH_FIELDS.length; toggleIndex += 1) {
        var toggleField = SWITCH_FIELDS[toggleIndex];
        children.push(
          React.createElement(Switch, {
            key: toggleField.key,
            t: t,
            field: toggleField,
            value: values[toggleField.key],
            onValue: function (key) {
              return function (next) {
                stage(key, next);
              };
            }(toggleField.key),
          }),
        );
      }

      var notes = [];
      if (status !== null && status.kind === 'saved') notes.push(React.createElement('p', { className: 'dcbc__saved', key: 'saved' }, t.saved));
      if (status !== null && status.kind === 'rejected') {
        notes.push(React.createElement('p', { className: 'dcbc__error', key: 'rejected' }, t.rejected + (state.status || '')));
      }
      if (status !== null && status.kind === 'failed') {
        notes.push(React.createElement('p', { className: 'dcbc__error', key: 'failed' }, t.failed + status.reason));
      }

      children.push(
        React.createElement(
          'div',
          { className: 'dcbc__actions', key: 'actions' },
          React.createElement(
            'button',
            { type: 'button', className: 'dcbc__btn', disabled: busy || !edited || blocked, onClick: save },
            busy ? t.saving : t.save,
          ),
          edited
            ? React.createElement(
              'button',
              {
                type: 'button',
                className: 'dcbc__btn dcbc__btn--quiet',
                disabled: busy,
                onClick: function () {
                  setEdits({});
                  setStatus(null);
                },
              },
              t.reset,
            )
            : null,
          notes,
        ),
      );

      return React.createElement('div', { className: 'dcbc' }, children);
    }

    /**
     * Register the form on the row's page and on the bundle's page: the bundle
     * page is where a user lands first, the row page is where dsh puts a row's
     * own configuration.
     */
    function register(ctx) {
      var entries = [
        [ROW_CONFIG_SLOT, ROW_CONFIG_KEY],
        [BUNDLE_CONFIG_SLOT, PACKAGE_ID],
      ];
      for (var index = 0; index < entries.length; index += 1) {
        try {
          ctx.slots.inject(entries[index][0], function (slotName, key) {
            return function () {
              return ctx.slots.register(
                {
                  name: slotName,
                  key: key,
                  label: function () {
                    return copy().title;
                  },
                },
                ConfigPage,
              );
            };
          }(entries[index][0], entries[index][1]));
        } catch (error) {
          try {
            console.error('[' + PACKAGE_ID + '] ' + entries[index][0] + ' registration failed:', error);
          } catch (ignored) {
            /* console may be gone; nothing else to do */
          }
        }
      }
    }

    /**
     * Bind to the client context.
     * @param ctx - client cordis context.
     */
    function apply(ctx) {
      installStyles();
      clientContext = ctx;
      resolveRowForm();
      register(ctx);
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = {
      CSS: CSS,
      ROW_CONFIG_KEY: ROW_CONFIG_KEY,
      BUNDLE_CONFIG_SLOT: BUNDLE_CONFIG_SLOT,
      ROW_CONFIG_SLOT: ROW_CONFIG_SLOT,
      ConfigPage: ConfigPage,
      validateHost: validateHost,
      isStored: isStored,
      copy: copy,
    };
    return module.exports;
  },
});
