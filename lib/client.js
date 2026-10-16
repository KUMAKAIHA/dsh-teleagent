window.__ModuleLoader__.load({
  id: "dsh-teleagent",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require("react");
    const h = react.createElement;

    const NS = "teleagent";
    const BRIDGE = "/api/dsh-teleagent-settings";
    const LOGIN_PAGE = "https://agent.teleai.com.cn/meter/teleagent-login/login?view=login";

    /**
     * Theme tokens.
     *
     * Every colour comes from DSH's own alias variables (the same set dsh-pet
     * uses). Hard-coded greys and translucent whites only read correctly in the
     * light theme — in dark mode the panel became low-contrast text on a
     * near-white card. Tokens make it follow the shell theme instead.
     */
    const T = {
      labelPrimary: "var(--dsw-alias-label-primary)",
      labelSecondary: "var(--dsw-alias-label-secondary)",
      labelTertiary: "var(--dsw-alias-label-tertiary)",
      labelCaption: "var(--dsw-alias-label-caption)",
      labelDimmed: "var(--dsw-alias-label-dimmed)",
      bgLayer: "var(--dsw-alias-bg-layer-1)",
      borderL1: "var(--dsw-alias-border-l1)",
      borderL2: "var(--dsw-alias-border-l2)",
      business: "var(--dsw-alias-state-business-primary)",
      success: "var(--dsw-alias-state-success-primary)",
      error: "var(--dsw-alias-state-error-primary)",
      infoFill: "var(--dsw-alias-button-info-fill)",
      hover: "var(--dsw-alias-interactive-bg-hover)",
      radiusMd: "var(--dsw-radius-md, 10px)",
      radiusSm: "var(--dsw-radius-sm, 6px)",
    };

    const btn = {
      padding: "6px 14px", cursor: "pointer", fontSize: 13,
      borderRadius: T.radiusSm,
      border: `1px solid ${T.borderL2}`,
      background: T.bgLayer,
      color: T.labelPrimary,
    };
    const btnPrimary = { ...btn, background: T.infoFill, color: "#fff", borderColor: "transparent" };
    const input = {
      width: "100%", padding: "7px 9px", fontSize: 13,
      borderRadius: T.radiusSm,
      border: `1px solid ${T.borderL2}`,
      background: T.bgLayer,
      color: T.labelPrimary,
      boxSizing: "border-box",
    };
    const card = {
      border: `1px solid ${T.borderL1}`,
      borderRadius: T.radiusMd,
      padding: 18, marginBottom: 16,
      background: T.bgLayer,
      color: T.labelPrimary,
    };
    const rowLabel = { fontSize: 13, fontWeight: 600, marginBottom: 6, display: "block", color: T.labelPrimary };
    const hint = { fontSize: 11, marginTop: 4, lineHeight: 1.6, color: T.labelTertiary };
    const kv = { display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0", gap: 12, color: T.labelSecondary };

    const FIELDS = [
      { key: "tier", label: "默认档位", type: "select", hint: "不指定模型时使用的档位", options: [
        { v: "chat-flagship", t: "旗舰 · chat-flagship（能力更强）" },
        { v: "chat-flash", t: "极速 · chat-flash（响应更快）" },
        { v: "chat-pro", t: "智能 · chat-pro" },
        { v: "chat-lite", t: "轻量 · chat-lite" },
        { v: "chat-nano", t: "轻速 · chat-nano" },
      ] },
      { key: "tools", label: "启用工具调用", type: "boolean", hint: "只读工具（读文件 / 搜索 / 抓网页）。写操作默认关闭。" },
      { key: "autoStart", label: "DSH 启动时自动拉起内核", type: "boolean", hint: "关闭后需手动点「启动内核」" },
      { key: "maxTokens", label: "单次最大输出 token", type: "number", hint: "0 = 使用档位默认值" },
      { key: "requestIntervalMs", label: "请求最小间隔（毫秒）", type: "number", hint: "调大可降低触发上游风控的概率" },
      { key: "enginePort", label: "内核端口", type: "number", hint: "官方应用默认占用 4397，插件默认 4399 以避免冲突" },
      { key: "proxyPort", label: "签名代理端口", type: "number" },
      { key: "kernelPath", label: "内核二进制路径", type: "text", hint: "留空自动从 TeleAgent 安装目录探测" },
      { key: "stateDir", label: "内核数据目录", type: "text", hint: "留空使用 ~/.dsh/teleagent" },
    ];

    function Field(props) {
      const { f, value, onChange } = props;
      let control;
      if (f.type === "boolean") {
        control = h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" } },
          h("input", { type: "checkbox", checked: value !== false, onChange: (e) => onChange(e.target.checked) }),
          h("span", { style: { fontSize: 12, opacity: 0.75 } }, value !== false ? "已开启" : "已关闭"));
      } else if (f.type === "select") {
        control = h("select", { style: input, value: value ?? "", onChange: (e) => onChange(e.target.value) },
          f.options.map((o) => h("option", { key: o.v, value: o.v }, o.t)));
      } else if (f.type === "number") {
        control = h("input", { style: input, type: "number", value: value ?? 0, onChange: (e) => onChange(Number(e.target.value)) });
      } else {
        control = h("input", { style: input, type: "text", value: value ?? "", onChange: (e) => onChange(e.target.value) });
      }
      return h("div", { style: { margin: "14px 0" } },
        h("span", { style: rowLabel }, f.label),
        control,
        f.hint ? h("div", { style: hint }, f.hint) : null);
    }

    function TeleAgentSection() {
      const [state, setState] = react.useState({ status: "loading" });
      const [draft, setDraft] = react.useState({});
      const [busy, setBusy] = react.useState(false);
      const [note, setNote] = react.useState("");
      const [loginInput, setLoginInput] = react.useState("");
      const [waiting, setWaiting] = react.useState(false);

      const load = react.useCallback(async () => {
        try {
          const r = await fetch(BRIDGE);
          const j = await r.json();
          setState(j);
          setDraft(j.config ?? {});
        } catch (e) {
          setState({ status: "error", error: String((e && e.message) || e) });
        }
      }, []);
      react.useEffect(() => { load(); }, [load]);

      // While a login is pending the host polls the official callback, so the
      // panel only has to refresh to pick the token up.
      react.useEffect(() => {
        if (!waiting) return;
        const t = setInterval(async () => {
          const r = await fetch(BRIDGE + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pending" }) });
          const j = await r.json();
          if (j && j.ok && j.done) {
            setWaiting(false);
            setNote(j.account ? "登录成功：" + j.account : "登录成功");
            await load();
          }
        }, 2000);
        return () => clearInterval(t);
      }, [waiting, load]);

      const save = async () => {
        setBusy(true); setNote("");
        try {
          const r = await fetch(BRIDGE + "/mutate", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ns: NS, config: draft }) });
          const j = await r.json();
          setNote(j.ok ? "已保存" : "保存失败：" + (j.error ?? ""));
          await load();
        } catch (e) { setNote("保存失败：" + String((e && e.message) || e)); }
        setBusy(false);
      };

      const login = async (action, extra) => {
        setNote("");
        try {
          const r = await fetch(BRIDGE + "/login", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, ...(extra ?? {}) }) });
          const j = await r.json();
          if (!j.ok) { setNote("失败：" + (j.error ?? "")); return null; }
          if (action === "start") { setWaiting(true); setNote(j.opened ? "已打开官方登录页，完成后会自动接入" : "请手动打开浏览器访问该地址"); return j; }
          if (action === "submit") { setNote(j.account ? "登录成功：" + j.account : "登录成功"); await load(); }
          if (action === "logout") { setNote("已清除本地登录凭证"); await load(); }
          return j;
        } catch (e) { setNote("失败：" + String((e && e.message) || e)); return null; }
      };

      // The official page relays its redirect to window.parent, so embedding it
      // lets the panel receive the issued token directly — no copy/paste. The
      // token never leaves this page except into our own host bridge.
      const setContext = async (value) => {
        setNote("");
        try {
          const r = await fetch(BRIDGE + "/login", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "setContext", value }) });
          const j = await r.json();
          if (!j.ok) { setNote("设置失败：" + (j.error ?? "")); return; }
          setNote("上下文长度已设为 " + Number(j.context).toLocaleString());
          await load();
        } catch (e) { setNote("设置失败：" + String((e && e.message) || e)); }
      };

      const submitToken = async (token) => {
        const j = await login("submit", { token });
        if (j && j.ok) setWaiting(false);
      };

      react.useEffect(() => {
        const onMessage = (ev) => {
          const d = ev && ev.data;
          if (!d || d.type !== "loginRedirect" || typeof d.url !== "string") return;
          const m = /[?&]token=([^&]+)/.exec(d.url);
          const tok = m ? decodeURIComponent(m[1]) : d.url;
          submitToken(tok);
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      }, []);

      const s = state;
      const statusLine = (label, value, ok) => h("div", { style: kv },
        h("span", { style: { opacity: 0.7 } }, label),
        h("span", { style: { fontWeight: 500, color: ok === false ? T.error : ok === true ? T.success : T.labelPrimary } }, value));

      const header = h("div", { style: { marginBottom: 18 } },
        h("div", { style: { fontSize: 18, fontWeight: 700, marginBottom: 4, color: T.labelPrimary } }, "TeleAgent"),
        h("div", { style: hint }, "把 TeleAgent 的档位模型接入 DSH。登录一次即可，无需保持 TeleAgent 应用运行。"));

      if (s.status === "error") {
        return h("div", { style: { padding: 20 } }, header, h("div", { style: { color: T.error } }, "读取失败：" + s.error));
      }

      const statusCard = h("div", { style: card },
        h("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 10 } }, "运行状态"),
        statusLine("内核", s.running ? "运行中" : "未运行", s.running === true),
        statusLine("账号", s.signedOut || !s.account ? "未登录" : s.account, s.signedOut || !s.account ? null : true),
        s.tokenExpires ? statusLine("凭证有效期", String(s.tokenExpires).slice(0, 10)) : null,
        statusLine("凭证来源", s.tokenSource === "login" ? "官方登录" : s.tokenSource === "app" ? "TeleAgent 应用" : "无"),
        s.tokenState === "missing"
          ? h("div", { style: { marginTop: 8, fontSize: 12, color: T.labelSecondary } },
              "未检测到登录凭证。请在下方登录，或在 TeleAgent 应用里重新登录。")
          : null,
        s.tokenState === "invalid"
          ? h("div", { style: { marginTop: 8, fontSize: 12, color: T.labelSecondary } },
              "本地凭证已失效（可能已在别处退出登录）。请重新登录。")
          : null,
        s.kernelPath ? statusLine("内核路径", s.kernelPath) : null,
        Array.isArray(s.tiers) && s.tiers.length
          ? h("div", { style: { marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.borderL1}` } },
              h("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 6 } }, "档位上下文"),
              s.tiers.map((t) => h("div", { key: t.id, style: kv },
                h("span", { style: { opacity: 0.7 } }, t.name + " · " + t.id),
                h("span", null, Number(t.context).toLocaleString() + " tokens"))))
          : null,
        s.lastError ? h("div", { style: { marginTop: 10, color: T.error, fontSize: 12, wordBreak: "break-all" } }, "最近错误：" + s.lastError) : null,
        // No kernel controls: the kernel's lifetime follows DSH's own
        // lifecycle, so there is nothing for the user to manage here.
        h("div", { style: { display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" } },
          h("button", { style: btn, onClick: load }, "刷新")));

      const loginCard = h("div", { style: card },
        h("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 6, color: T.labelPrimary } }, "登录"),
        h("div", { style: hint },
          "点「打开官方登录页」：插件会在本机开一个回调监听，浏览器里用手机号 + 验证码登录完成后**自动接入**，无需复制粘贴。"),
        h("div", { style: { display: "flex", gap: 8, marginTop: 14, alignItems: "center", flexWrap: "wrap" } },
          h("button", { style: btnPrimary, onClick: () => login("start") }, waiting ? "重新打开登录页" : "打开官方登录页"),
          h("button", { style: btn, onClick: () => login("logout") }, "清除登录"),
          waiting ? h("span", { style: { fontSize: 12, color: T.labelSecondary } }, "等待登录完成…") : null),

        // 失败回退：粘贴回调地址。始终可用，不依赖浏览器能否回跳本机。
        h("div", { style: { marginTop: 16, paddingTop: 14, borderTop: `1px solid ${T.borderL1}` } },
          h("span", { style: rowLabel }, "或粘贴回调地址（回退）"),
          h("div", { style: hint }, "若自动接入未生效，登录后地址栏会停在 …/cowork/auth?code=…&token=… ，复制整段粘贴到这里。"),
          h("textarea", {
            placeholder: "https://agent.teleai.com.cn/superCowork/sapi/cowork/auth?code=…&token=…",
            value: loginInput,
            onChange: (e) => setLoginInput(e.target.value),
            style: { ...input, height: 64, marginTop: 8, fontFamily: "ui-monospace, monospace", fontSize: 11, resize: "vertical" },
          }),
          h("button", { style: { ...btn, marginTop: 8 }, onClick: () => login("submit", { token: loginInput }) }, "提交")),

        note ? h("div", { style: { marginTop: 12, fontSize: 12, color: T.labelSecondary } }, note) : null);

      const contextCard = h("div", { style: card },
        h("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, "上下文长度"),
        h("div", { style: hint }, "与 TeleAgent 应用里的「上下文长度」是同一份设置，修改后立即对所有档位生效。"),
        h("div", { style: { display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" } },
          h("input", { type: "number", value: draft.contextLength ?? ctxValue ?? "", style: { ...input, width: 180 },
            onChange: (e) => setDraft((d) => ({ ...d, contextLength: Number(e.target.value) })) }),
          presets.map((n) => h("button", { key: n, style: btn, onClick: () => setContext(n) },
            n >= 1000000 ? "1M" : (n / 1000) + "K"))),
        h("div", { style: { marginTop: 10 } },
          h("button", { style: btnPrimary, onClick: () => setContext(draft.contextLength ?? ctxValue) }, "应用上下文长度")));

      const settingsCard = h("div", { style: card },
        h("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, "设置"),
        FIELDS.map((f) => h(Field, { key: f.key, f, value: draft[f.key], onChange: (v) => setDraft((d) => ({ ...d, [f.key]: v })) })),
        h("div", { style: { display: "flex", gap: 8, marginTop: 16, alignItems: "center" } },
          h("button", { style: btnPrimary, disabled: busy, onClick: save }, busy ? "保存中…" : "保存")));

      return h("div", { style: { padding: "4px 2px 32px", maxWidth: 720 } },
        header, statusCard, loginCard, contextCard, settingsCard);
    }

    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.section", function* () {
        yield ctx.slots.register({
          name: "settings.section",
          id: "teleagent",
          order: 35,
          label: () => "TeleAgent",
        }, TeleAgentSection);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
