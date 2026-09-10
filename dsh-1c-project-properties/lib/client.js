// dsh-1c-project-properties — клиентская половина.
//
// Вкладка «1С: параметры» в Settings: список проектов (воркспейсы DSH + добавленные
// вручную пути) и форма параметров выбранного проекта. Значения пишет хост-половина
// в файл .dsh/1c-project.json внутри папки проекта.
window.__ModuleLoader__.load({
  id: "dsh-1c-project-properties",
  factory: (require) => {
    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { useState, useEffect, useCallback } = React;

    const API = "/1cprops";
    const PLATFORM_LIST_ID = "dsh-1cprops-platforms";

    async function request(path, init) {
      const response = await fetch(API + path, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || response.statusText || "HTTP " + response.status);
      }
      return data;
    }

    const styles = {
      input: {
        boxSizing: "border-box",
        width: "100%",
        height: 30,
        padding: "0 8px",
        borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-base)",
        color: "inherit",
        font: "var(--dsw-font-s-14)",
      },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: 12,
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 10,
        padding: 14,
      },
      cardTitle: { fontSize: 13, fontWeight: 600 },
      subtitle: { opacity: 0.6, fontSize: 12, marginTop: 3, lineHeight: 1.5 },
      fieldLabel: { marginBottom: 4, opacity: 0.7, fontSize: 12 },
      field: { display: "block", marginBottom: 12 },
      hint: { marginTop: 4, opacity: 0.55, fontSize: 11, lineHeight: 1.5 },
      path: { fontFamily: "monospace", fontSize: 11, opacity: 0.75, wordBreak: "break-all", userSelect: "text" },
      list: { flex: "0 0 auto", width: 260, display: "flex", flexDirection: "column", gap: 4 },
      listItem: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
        width: "100%",
        minWidth: 0,
        padding: "6px 8px",
        borderRadius: 6,
        border: "1px solid transparent",
        background: "transparent",
        color: "inherit",
        textAlign: "left",
        cursor: "pointer",
        font: "var(--dsw-font-s-14)",
      },
      listItemActive: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
        width: "100%",
        minWidth: 0,
        padding: "6px 8px",
        borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "rgba(127,127,127,0.12)",
        color: "inherit",
        textAlign: "left",
        cursor: "pointer",
        font: "var(--dsw-font-s-14)",
      },
      primaryButton: {
        flex: "0 0 auto",
        height: 30,
        padding: "0 14px",
        border: "none",
        borderRadius: 8,
        cursor: "pointer",
        background: "var(--dsw-alias-state-business-primary, #3964fe)",
        color: "#fff",
        font: "var(--dsw-font-s-14)",
      },
      secondaryButton: {
        flex: "0 0 auto",
        height: 30,
        padding: "0 12px",
        borderRadius: 8,
        cursor: "pointer",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "transparent",
        color: "inherit",
        font: "var(--dsw-font-s-14)",
      },
      dangerButton: {
        flex: "0 0 auto",
        height: 30,
        padding: "0 12px",
        borderRadius: 8,
        cursor: "pointer",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "transparent",
        color: "#e57373",
        font: "var(--dsw-font-s-14)",
      },
    };

    const EMPTY_FORM = { infobasePath: "", user: "", password: "", platformPath: "" };

    function Section() {
      const [state, setState] = useState(null);
      const [selected, setSelected] = useState(null);
      const [form, setForm] = useState(EMPTY_FORM);
      const [commonPlatform, setCommonPlatform] = useState("");
      const [showPassword, setShowPassword] = useState(false);
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState(false);
      const [newPath, setNewPath] = useState("");

      const load = useCallback(async () => {
        try {
          const data = await request("/state");
          setState(data);
          setCommonPlatform(data.common ? data.common.platformPath || "" : "");
          setSelected((current) => (current && data.projects.some((p) => p.path === current) ? current : data.projects[0] ? data.projects[0].path : null));
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const project = state ? state.projects.find((p) => p.path === selected) || null : null;

      useEffect(() => {
        if (!project) {
          setForm(EMPTY_FORM);
          return;
        }
        setForm({
          infobasePath: project.params.infobasePath || "",
          user: project.params.user || "",
          password: project.params.password || "",
          platformPath: project.params.platformPath || "",
        });
        setShowPassword(false);
      }, [state, selected]);

      const run = async (action, message) => {
        setBusy(true);
        try {
          const result = await action();
          setStatus({ kind: "ok", text: message });
          return result;
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
          return null;
        } finally {
          setBusy(false);
        }
      };

      const saveCommon = () =>
        run(async () => {
          await request("/common", { method: "POST", body: JSON.stringify({ platformPath: commonPlatform }) });
          await load();
        }, "Общие настройки сохранены");

      const saveProject = () => {
        if (!project) return;
        run(async () => {
          await request("/project-save", { method: "POST", body: JSON.stringify({ path: project.path, params: form }) });
          await load();
        }, "Параметры проекта сохранены");
      };

      const clearProject = () => {
        if (!project) return;
        const question = "Удалить файл " + state.paramsRel + " у проекта «" + project.title + "»?";
        if (typeof window !== "undefined" && !window.confirm(question)) return;
        run(async () => {
          await request("/project-clear", { method: "POST", body: JSON.stringify({ path: project.path }) });
          await load();
        }, "Файл параметров удалён");
      };

      const forgetProject = () => {
        if (!project) return;
        run(async () => {
          await request("/project-forget", { method: "POST", body: JSON.stringify({ path: project.path }) });
          await load();
        }, "Проект убран из списка");
      };

      const addProject = () => {
        const path = newPath.trim();
        if (!path) return;
        run(async () => {
          const data = await request("/project-add", { method: "POST", body: JSON.stringify({ path }) });
          setNewPath("");
          setSelected(data.path);
          await load();
        }, "Проект добавлен в список");
      };

      if (state === null) {
        return jsx("div", { style: { opacity: 0.7 }, children: status ? status.text : "Загрузка параметров…" });
      }

      const projects = state.projects || [];
      const platforms = state.platforms || [];
      const platformPlaceholder = state.common.platformPath || "(не задано в общих настройках)";

      const statusLine = status
        ? jsx("div", {
            style: { fontSize: 12, color: status.kind === "ok" ? "#4caf50" : "#e57373" },
            children: status.text,
          })
        : null;

      const projectCard = !project
        ? jsx("div", { style: styles.hint, children: "Выберите проект в списке слева." })
        : jsxs("div", { style: styles.card, children: [
            jsxs("div", { children: [
              jsx("div", { style: { fontSize: 13, fontWeight: 600 }, children: project.title }),
              jsx("div", { style: styles.path, children: project.path }),
              jsx("div", { style: styles.hint, children: project.hasFile
                ? "Файл параметров: " + project.filePath
                : "Файла ещё нет — он появится при сохранении: " + project.filePath }),
            ]}),
            jsxs("div", { style: styles.field, children: [
              jsx("div", { style: styles.fieldLabel, children: "Путь к базе" }),
              jsx("input", {
                style: styles.input,
                value: form.infobasePath,
                placeholder: "C:\\Базы\\Бухгалтерия  либо  Srvr=\"server\";Ref=\"buh\";",
                onChange: (e) => setForm((f) => ({ ...f, infobasePath: e.target.value })),
              }),
              jsx("div", { style: styles.hint, children: "Папка файловой базы или строка соединения с сервером 1С. Хранится как есть, без проверки." }),
            ]}),
            jsxs("div", { style: { display: "flex", gap: 12 }, children: [
              jsxs("div", { style: { flex: "1 1 0", minWidth: 0, marginBottom: 12 }, children: [
                jsx("div", { style: styles.fieldLabel, children: "Пользователь" }),
                jsx("input", {
                  style: styles.input,
                  value: form.user,
                  onChange: (e) => setForm((f) => ({ ...f, user: e.target.value })),
                }),
              ]}),
              jsxs("div", { style: { flex: "1 1 0", minWidth: 0, marginBottom: 12 }, children: [
                jsxs("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between" }, children: [
                  jsx("div", { style: styles.fieldLabel, children: "Пароль" }),
                  jsxs("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, opacity: 0.7, cursor: "pointer" }, children: [
                    jsx("input", {
                      type: "checkbox",
                      checked: showPassword,
                      onChange: (e) => setShowPassword(e.target.checked),
                    }),
                    "показать",
                  ]}),
                ]}),
                jsx("input", {
                  style: styles.input,
                  type: showPassword ? "text" : "password",
                  value: form.password,
                  onChange: (e) => setForm((f) => ({ ...f, password: e.target.value })),
                }),
              ]}),
            ]}),
            jsxs("div", { style: styles.field, children: [
              jsx("div", { style: styles.fieldLabel, children: "Путь к платформе 1С" }),
              jsx("input", {
                style: styles.input,
                list: PLATFORM_LIST_ID,
                value: form.platformPath,
                placeholder: platformPlaceholder,
                onChange: (e) => setForm((f) => ({ ...f, platformPath: e.target.value })),
              }),
              jsx("div", { style: styles.hint, children: form.platformPath
                ? "Путь задан для этого проекта."
                : "Пусто — будет использован путь из общих настроек: " + (state.common.platformPath || "не задан") }),
            ]}),
            jsxs("div", { style: { display: "flex", gap: 8, alignItems: "center" }, children: [
              jsx("button", { type: "button", style: styles.primaryButton, disabled: busy, onClick: saveProject, children: "Сохранить" }),
              jsx("button", { type: "button", style: styles.dangerButton, disabled: busy || !project.hasFile, onClick: clearProject, children: "Удалить файл" }),
              project.source === "extra"
                ? jsx("button", { type: "button", style: styles.secondaryButton, disabled: busy, onClick: forgetProject, children: "Убрать из списка" })
                : null,
              jsx("span", { style: { opacity: 0.55, fontSize: 11 }, children: "Пароль хранится в открытом виде — не коммитьте файл в git." }),
            ]}),
          ]});

      return jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 16, maxWidth: 900 }, children: [
        jsxs("div", { children: [
          jsx("div", { style: { fontSize: 14, fontWeight: 600 }, children: "Параметры 1С по проектам" }),
          jsx("div", { style: styles.subtitle, children: "Значения каждого проекта лежат в файле " + state.paramsRel + " внутри его папки — их видно в git, можно править руками и читать другими инструментами." }),
        ]}),
        statusLine,
        jsxs("div", { style: styles.card, children: [
          jsx("div", { style: styles.cardTitle, children: "Общие — значения по умолчанию" }),
          jsxs("div", { style: { display: "flex", gap: 8, alignItems: "flex-start" }, children: [
            jsxs("div", { style: { flex: "1 1 auto", minWidth: 0 }, children: [
              jsx("div", { style: styles.fieldLabel, children: "Путь к платформе 1С" }),
              jsx("input", {
                style: styles.input,
                list: PLATFORM_LIST_ID,
                value: commonPlatform,
                placeholder: "C:\\Program Files\\1cv8\\8.3.27.2130\\bin\\1cv8.exe",
                onChange: (e) => setCommonPlatform(e.target.value),
              }),
              jsx("div", { style: styles.hint, children: platforms.length
                ? "Найдено платформ: " + platforms.length + " — начните вводить путь или выберите из списка."
                : "Установленные платформы не найдены в стандартных каталогах — укажите путь вручную." }),
            ]}),
            jsx("button", { type: "button", style: styles.primaryButton, disabled: busy, onClick: saveCommon, children: "Сохранить" }),
          ]}),
        ]}),
        jsxs("div", { style: { display: "flex", gap: 16, alignItems: "flex-start" }, children: [
          jsxs("div", { style: styles.list, children: [
            jsx("div", { style: styles.fieldLabel, children: "Проекты (" + projects.length + ")" }),
            projects.length === 0
              ? jsx("div", { style: styles.hint, children: "В DSH не зарегистрировано ни одного воркспейса. Добавьте путь к папке проекта ниже." })
              : jsx("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: projects.map((p) =>
                  jsxs("button", {
                    key: p.path,
                    type: "button",
                    title: p.path,
                    onClick: () => setSelected(p.path),
                    style: p.path === selected ? styles.listItemActive : styles.listItem,
                    children: [
                      jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: p.title }),
                      jsx("span", { style: { opacity: 0.55, fontSize: 10, flex: "0 0 auto" }, children: p.hasFile ? "●" : "○" }),
                    ],
                  }, p.path)) }),
            jsxs("div", { style: { display: "flex", gap: 6, marginTop: 8 }, children: [
              jsx("input", {
                style: styles.input,
                value: newPath,
                placeholder: "D:\\путь\\к\\проекту",
                onChange: (e) => setNewPath(e.target.value),
              }),
              jsx("button", { type: "button", style: styles.secondaryButton, disabled: busy || !newPath.trim(), onClick: addProject, children: "Добавить" }),
            ]}),
            jsx("div", { style: styles.hint, children: "● — файл параметров есть, ○ — ещё не создан." }),
          ]}),
          jsx("div", { style: { flex: "1 1 auto", minWidth: 0 }, children: projectCard }),
        ]}),
        jsx("datalist", { id: PLATFORM_LIST_ID, children: platforms.map((p) => jsx("option", { key: p.path, value: p.path, children: p.version })) }),
      ]});
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "1c-project-properties",
            order: 55,
            label: () => "1С: параметры",
            registrant: "dsh-1c-project-properties",
          },
          Section,
        ),
      );
    }

    return { apply, inject: ["slots"] };
  },
});
