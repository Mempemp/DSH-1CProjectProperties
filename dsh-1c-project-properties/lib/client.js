// dsh-1c-project-properties — клиентская половина.
//
// Вкладка «1С: Параметры проектов» в Settings: список проектов (воркспейсы DSH +
// добавленные вручную пути) и общие значения. Параметры конкретного проекта
// редактируются в отдельном модальном окне (шестерёнка у строки проекта) — в
// колонке настроек шириной ~520 px форма не помещается.
// Значения пишет хост-половина в файл .dsh/1c-project.json внутри папки проекта.
window.__ModuleLoader__.load({
  id: "dsh-1c-project-properties",
  factory: (require) => {
    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { useState, useEffect, useCallback } = React;
    const ReactDOM = (() => {
      try {
        return require("react-dom");
      } catch {
        return null;
      }
    })();

    // Модальное окно выносим в document.body: панель настроек обрезает содержимое.
    const portal = (node) =>
      ReactDOM && typeof ReactDOM.createPortal === "function" && typeof document !== "undefined"
        ? ReactDOM.createPortal(node, document.body)
        : node;

    const API = "/1cprops";
    const PLATFORM_LIST_ID = "dsh-1cprops-platforms";
    const INFOBASE_LIST_ID = "dsh-1cprops-infobases";

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
        gap: 10,
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 10,
        padding: 12,
      },
      cardTitle: { fontSize: 13, fontWeight: 600 },
      subtitle: { opacity: 0.6, fontSize: 12, marginTop: 3, lineHeight: 1.5 },
      fieldLabel: { marginBottom: 4, opacity: 0.7, fontSize: 12 },
      hint: { marginTop: 4, opacity: 0.55, fontSize: 11, lineHeight: 1.5 },
      path: { fontFamily: "monospace", fontSize: 11, opacity: 0.7, wordBreak: "break-all", userSelect: "text" },
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
      // строка проекта в списке
      row: {
        display: "flex",
        flexDirection: "column",
        gap: 2,
        width: "100%",
        minWidth: 0,
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid transparent",
        background: "rgba(127,127,127,0.06)",
        cursor: "pointer",
      },
      rowTop: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
      rowTitle: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      // модальное окно
      overlay: {
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      mask: {
        position: "absolute",
        inset: 0,
        background: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.45))",
      },
      dialog: {
        position: "relative",
        zIndex: 1,
        display: "flex",
        flexDirection: "column",
        width: 760,
        maxWidth: "calc(100vw - 48px)",
        maxHeight: "calc(100vh - 48px)",
        borderRadius: 24,
        background: "var(--dsw-alias-bg-layer-2, #1f2026)",
        color: "var(--dsw-alias-label-primary, inherit)",
        boxShadow: "var(--dsw-elevation-prominent, 0 18px 48px rgba(0,0,0,.45))",
        overflow: "hidden",
      },
      dialogHeader: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
        padding: "20px 24px 12px",
      },
      dialogBody: { padding: "4px 24px 8px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 },
      dialogFooter: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "12px 24px 18px",
        flexWrap: "wrap",
      },
      grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
      full: { gridColumn: "1 / -1" },
      sectionTitle: { fontSize: 13, fontWeight: 600, marginBottom: 8 },
    };

    const EMPTY_FORM = { infobasePath: "", user: "", password: "", platformPath: "", unlockCode: "", dumpDir: "" };

    const EMPTY_RUN = { format: "Hierarchical", update: false, cleanLocks: false };

    const gearIcon = () =>
      jsxs("svg", {
        width: 15,
        height: 15,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.8,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        children: [
          jsx("circle", { cx: 12, cy: 12, r: 3.2 }),
          jsx("path", {
            d: "M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.7h.09A1.7 1.7 0 0 0 10.11 3.14V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z",
          }),
        ],
      });

    const JOB_LABEL = {
      running: "идёт выгрузка",
      done: "выгрузка завершена",
      failed: "выгрузка не удалась",
      cancelled: "выгрузка отменена",
    };

    const JOB_COLOR = { running: "inherit", done: "#4caf50", failed: "#e57373", cancelled: "#e57373" };

    /** Модальное окно параметров одного проекта. */
    function ProjectDialog(props) {
      const {
        project,
        state,
        form,
        setForm,
        showPassword,
        setShowPassword,
        runOptions,
        setRunOptions,
        job,
        busy,
        infoBaseHint,
        platformPlaceholder,
        infoBases,
        platforms,
        onSave,
        onClear,
        onForget,
        onStartDump,
        onCancelDump,
        onClose,
      } = props;

      // Escape закрывает окно и НЕ закрывает настройки: перехватываем на фазе
      // перехвата, пока обработчик панели настроек (bubble) не сработал.
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => document.removeEventListener("keydown", onKeyDown, true);
      }, [onClose]);

      const running = Boolean(job && job.state === "running");
      const jobIsHere = Boolean(job && job.path === project.path);
      const canRun = Boolean(project.params.infobasePath);
      const checkbox = (label, key) =>
        jsxs("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }, children: [
          jsx("input", {
            type: "checkbox",
            checked: runOptions[key],
            disabled: running && jobIsHere,
            onChange: (e) => setRunOptions((o) => ({ ...o, [key]: e.target.checked })),
          }),
          label,
        ] });

      const jobLine = job && jobIsHere && job.state !== "idle"
        ? jsxs("div", { style: { fontSize: 12, lineHeight: 1.6 }, children: [
            jsx("span", { style: { fontWeight: 600, color: JOB_COLOR[job.state] || "inherit" }, children: JOB_LABEL[job.state] || job.state }),
            jsx("span", { style: { opacity: 0.7 }, children: " · " + Math.round((job.elapsedMs || 0) / 1000) + " с" }),
            job.files ? jsx("span", { style: { opacity: 0.7 }, children: " · файлов: " + job.files }) : null,
            job.version ? jsx("span", { style: { opacity: 0.7 }, children: " · версия конфигурации: " + job.version }) : null,
            job.error ? jsx("div", { style: { color: "#e57373" }, children: job.error }) : null,
            jsx("div", { style: { opacity: 0.7, wordBreak: "break-all" }, children: "каталог: " + job.dir }),
          ]})
        : null;

      const jobLog = job && jobIsHere && job.log && job.state !== "running"
        ? jsx("pre", {
            style: {
              margin: 0,
              maxHeight: 220,
              overflow: "auto",
              padding: 8,
              borderRadius: 8,
              background: "rgba(127,127,127,0.08)",
              fontSize: 11,
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
            },
            children: job.log,
          })
        : null;

      return portal(jsxs("div", { style: styles.overlay, children: [
        jsx("div", { style: styles.mask, onClick: onClose, "aria-hidden": "true" }),
        jsxs("div", { style: styles.dialog, role: "dialog", "aria-modal": "true", children: [
          jsxs("div", { style: styles.dialogHeader, children: [
            jsxs("div", { style: { minWidth: 0 }, children: [
              jsx("div", { style: { fontSize: 15, fontWeight: 600 }, children: "Параметры проекта" }),
              jsx("div", { style: { fontSize: 13, marginTop: 2 }, children: project.title }),
              jsx("div", { style: styles.path, children: project.path }),
            ]}),
            jsx("button", {
              type: "button",
              title: "Закрыть",
              onClick: onClose,
              style: { flex: "0 0 auto", width: 28, height: 28, padding: 0, border: "none", borderRadius: 28, background: "transparent", color: "inherit", cursor: "pointer", fontSize: 18, lineHeight: "24px" },
              children: "×",
            }),
          ]}),
          jsxs("div", { style: styles.dialogBody, children: [
            jsxs("div", { children: [
              jsx("div", { style: styles.sectionTitle, children: "Параметры 1С" }),
              jsxs("div", { style: styles.grid, children: [
                jsxs("div", { style: styles.full, children: [
                  jsx("div", { style: styles.fieldLabel, children: "Путь к базе" }),
                  jsx("input", {
                    style: styles.input,
                    list: INFOBASE_LIST_ID,
                    autoFocus: true,
                    value: form.infobasePath,
                    placeholder: 'C:\\Базы\\Бухгалтерия  либо  Srvr="server";Ref="buh";',
                    onChange: (e) => setForm((f) => ({ ...f, infobasePath: e.target.value })),
                  }),
                  jsxs("div", { style: styles.hint, children: [
                    "Папка файловой базы или строка соединения с сервером 1С. Хранится как есть, без проверки.",
                    jsx("div", { children: infoBaseHint }),
                  ]}),
                ]}),
                jsxs("div", { children: [
                  jsx("div", { style: styles.fieldLabel, children: "Пользователь" }),
                  jsx("input", {
                    style: styles.input,
                    value: form.user,
                    onChange: (e) => setForm((f) => ({ ...f, user: e.target.value })),
                  }),
                ]}),
                jsxs("div", { children: [
                  jsxs("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between" }, children: [
                    jsx("div", { style: styles.fieldLabel, children: "Пароль" }),
                    jsxs("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, opacity: 0.7, cursor: "pointer" }, children: [
                      jsx("input", { type: "checkbox", checked: showPassword, onChange: (e) => setShowPassword(e.target.checked) }),
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
                jsxs("div", { style: styles.full, children: [
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
                jsxs("div", { children: [
                  jsx("div", { style: styles.fieldLabel, children: "Код доступа к базе (/UC)" }),
                  jsx("input", {
                    style: styles.input,
                    value: form.unlockCode,
                    placeholder: "(пусто = без кода)",
                    onChange: (e) => setForm((f) => ({ ...f, unlockCode: e.target.value })),
                  }),
                  jsx("div", { style: styles.hint, children: "Нужен, если на базе стоит блокировка установки соединений с кодом доступа." }),
                ]}),
                jsxs("div", { children: [
                  jsx("div", { style: styles.fieldLabel, children: "Каталог выгрузки" }),
                  jsx("input", {
                    style: styles.input,
                    value: form.dumpDir,
                    placeholder: "пусто = корень проекта",
                    onChange: (e) => setForm((f) => ({ ...f, dumpDir: e.target.value })),
                  }),
                  jsx("div", { style: styles.hint, children: "Абсолютный путь или путь внутри проекта — куда писать XML." }),
                ]}),
              ]}),
            ]}),
            jsxs("div", { children: [
              jsx("div", { style: styles.sectionTitle, children: "Выгрузка конфигурации в файлы" }),
              jsxs("div", { style: { display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginBottom: 13 }, children: [
                jsxs("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 }, children: [
                  "Формат:",
                  jsxs("select", {
                    value: runOptions.format,
                    disabled: running && jobIsHere,
                    onChange: (e) => setRunOptions((o) => ({ ...o, format: e.target.value })),
                    style: {
                      height: 26,
                      borderRadius: 6,
                      border: "1px solid var(--dsw-alias-border-l2)",
                      background: "var(--dsw-alias-bg-base)",
                      color: "inherit",
                      font: "var(--dsw-font-s-14)",
                    },
                    children: [
                      jsx("option", { value: "Hierarchical", children: "иерархический" }),
                      jsx("option", { value: "Plain", children: "плоский" }),
                    ],
                  }),
                ]}),
                checkbox("только изменения (-update)", "update"),
                checkbox("снять .cfl перед выгрузкой", "cleanLocks"),
              ]}),
              jsxs("div", { style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }, children: [
                running && jobIsHere
                  ? jsx("button", { type: "button", style: styles.dangerButton, disabled: busy, onClick: onCancelDump, children: "Отменить выгрузку" })
                  : jsx("button", { type: "button", style: styles.primaryButton, disabled: busy || !canRun || running, onClick: onStartDump, children: "Выгрузить конфигурацию в файлы" }),
                !canRun
                  ? jsx("span", { style: styles.hint, children: "Сначала заполните путь к базе и нажмите «Сохранить»." })
                  : jsx("span", { style: { opacity: 0.55, fontSize: 11 }, children: "Конфигуратор блокирует конфигурацию базы — выгрузка идёт в один поток." }),
              ]}),
              jobLine,
              jobLog,
            ]}),
          ]}),
          jsxs("div", { style: styles.dialogFooter, children: [
            jsx("button", { type: "button", style: styles.primaryButton, disabled: busy, onClick: onSave, children: "Сохранить" }),
            jsx("button", { type: "button", style: styles.dangerButton, disabled: busy || !project.hasFile, onClick: onClear, children: "Удалить файл" }),
            project.source === "extra"
              ? jsx("button", { type: "button", style: styles.secondaryButton, disabled: busy, onClick: onForget, children: "Убрать из списка" })
              : null,
            jsx("span", {
              style: { flex: "1 1 auto", minWidth: 160, opacity: 0.55, fontSize: 11 },
              children: "Файл: " + project.filePath + " · пароль хранится открытым текстом",
            }),
            jsx("button", { type: "button", style: styles.secondaryButton, onClick: onClose, children: "Закрыть" }),
          ]}),
        ]}),
      ]}));
    }

    function Section() {
      const [state, setState] = useState(null);
      const [openPath, setOpenPath] = useState(null);
      const [form, setForm] = useState(EMPTY_FORM);
      const [commonPlatform, setCommonPlatform] = useState("");
      const [showPassword, setShowPassword] = useState(false);
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState(false);
      const [newPath, setNewPath] = useState("");
      const [job, setJob] = useState(null);
      const [runOptions, setRunOptions] = useState(EMPTY_RUN);

      const load = useCallback(async () => {
        try {
          const data = await request("/state");
          setState(data);
          setCommonPlatform(data.common ? data.common.platformPath || "" : "");
        } catch (error) {
          setStatus({ kind: "error", text: String((error && error.message) || error) });
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const project = state && openPath ? state.projects.find((p) => p.path === openPath) || null : null;

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
          unlockCode: project.params.unlockCode || "",
          dumpDir: project.params.dumpDir || "",
        });
        setShowPassword(false);
      }, [state, openPath]);

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
          setOpenPath(null);
          await load();
        }, "Проект убран из списка");
      };

      const addProject = () => {
        const path = newPath.trim();
        if (!path) return;
        run(async () => {
          const data = await request("/project-add", { method: "POST", body: JSON.stringify({ path }) });
          setNewPath("");
          setOpenPath(data.path);
          await load();
        }, "Проект добавлен в список");
      };

      // ── выгрузка конфигурации в файлы ──────────────────────────────────────
      const refreshJob = useCallback(async () => {
        try {
          const data = await request("/dump-status");
          setJob(data.job);
        } catch {}
      }, []);

      useEffect(() => {
        refreshJob();
      }, [refreshJob]);

      useEffect(() => {
        if (!job || job.state !== "running") return;
        const timer = setInterval(refreshJob, 2000);
        return () => clearInterval(timer);
      }, [job && job.state, refreshJob]);

      const startDump = () => {
        if (!project) return;
        run(async () => {
          const data = await request("/dump-start", {
            method: "POST",
            body: JSON.stringify({
              path: project.path,
              dir: form.dumpDir,
              format: runOptions.format,
              update: runOptions.update,
              cleanLocks: runOptions.cleanLocks,
            }),
          });
          setJob(data.job);
        }, "Выгрузка запущена");
      };

      const cancelDump = () =>
        run(async () => {
          const data = await request("/dump-cancel", { method: "POST", body: JSON.stringify({ path: project ? project.path : "" }) });
          setJob(data.job);
        }, "Выгрузка отменена");

      if (state === null) {
        return jsx("div", { style: { opacity: 0.7 }, children: status ? status.text : "Загрузка параметров…" });
      }

      const projects = state.projects || [];
      const platforms = state.platforms || [];
      const infoBases = state.infobases || [];
      const platformPlaceholder = state.common.platformPath || "C:\\Program Files\\1cv8\\…\\bin\\1cv8.exe";
      const infoBaseHint = (() => {
        const parts = [
          infoBases.length
            ? "Из списка баз 1С подставлено: " + infoBases.length + " — начните вводить имя базы или выберите из списка."
            : "Список баз 1С (ibases.v8i) не найден — путь вводится вручную.",
        ];
        if (state.infobasesWebSkipped) parts.push("Базы через веб-сервер пропущены: " + state.infobasesWebSkipped + ".");
        return parts.join(" ");
      })();

      const statusLine = status
        ? jsx("div", {
            style: { fontSize: 12, color: status.kind === "ok" ? "#4caf50" : "#e57373" },
            children: status.text,
          })
        : null;

      const jobStrip = job && job.state !== "idle"
        ? jsxs("div", {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              fontSize: 12,
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: 10,
              padding: "8px 12px",
            },
            children: [
              jsx("span", { style: { fontWeight: 600, color: JOB_COLOR[job.state] || "inherit" }, children: JOB_LABEL[job.state] || job.state }),
              jsx("span", { style: { opacity: 0.7 }, children: "«" + job.title + "» · " + Math.round((job.elapsedMs || 0) / 1000) + " с" + (job.files ? " · файлов: " + job.files : "") }),
              state.projects.some((p) => p.path === job.path)
                ? jsx("button", { type: "button", style: styles.secondaryButton, onClick: () => setOpenPath(job.path), children: "Открыть" })
                : null,
              job.state === "running"
                ? jsx("button", { type: "button", style: styles.dangerButton, disabled: busy, onClick: cancelDump, children: "Отменить" })
                : null,
            ],
          })
        : null;

      const dialog = project
        ? jsx(ProjectDialog, {
            project,
            state,
            form,
            setForm,
            showPassword,
            setShowPassword,
            runOptions,
            setRunOptions,
            job,
            busy,
            infoBaseHint,
            platformPlaceholder,
            infoBases,
            platforms,
            onSave: saveProject,
            onClear: clearProject,
            onForget: forgetProject,
            onStartDump: startDump,
            onCancelDump: cancelDump,
            onClose: () => setOpenPath(null),
          })
        : null;

      return jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 14 }, children: [
        jsxs("div", { children: [
          jsx("div", { style: { fontSize: 14, fontWeight: 600 }, children: "1С: Параметры проектов" }),
          jsx("div", { style: styles.subtitle, children: "Значения каждого проекта лежат в файле " + state.paramsRel + " внутри его папки — их видно в git, можно править руками и читать другими инструментами." }),
        ]}),
        statusLine,
        jobStrip,
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
        jsxs("div", { style: styles.card, children: [
          jsx("div", { style: styles.cardTitle, children: "Проекты (" + projects.length + ")" }),
          projects.length === 0
            ? jsx("div", { style: styles.hint, children: "В DSH не зарегистрировано ни одного воркспейса. Добавьте путь к папке проекта ниже." })
            : jsx("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: projects.map((p) =>
                jsxs("div", {
                  key: p.path,
                  role: "button",
                  tabIndex: 0,
                  title: "Открыть параметры проекта",
                  onClick: () => setOpenPath(p.path),
                  style: styles.row,
                  children: [
                    jsxs("div", { style: styles.rowTop, children: [
                      jsx("span", { style: styles.rowTitle, children: p.title }),
                      jsx("span", { style: { opacity: 0.6, fontSize: 10, flex: "0 0 auto" }, children: p.hasFile ? "●" : "○" }),
                      jsx("span", { style: { opacity: 0.6, flex: "0 0 auto", display: "flex" }, children: gearIcon() }),
                    ]}),
                    jsx("div", { style: { ...styles.path, opacity: 0.5, wordBreak: "normal", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: p.path }),
                  ],
                }, p.path)) }),
          jsxs("div", { style: { display: "flex", gap: 6, marginTop: 2 }, children: [
            jsx("input", {
              style: styles.input,
              value: newPath,
              placeholder: "D:\\путь\\к\\проекту",
              onChange: (e) => setNewPath(e.target.value),
            }),
            jsx("button", { type: "button", style: styles.secondaryButton, disabled: busy || !newPath.trim(), onClick: addProject, children: "Добавить" }),
          ]}),
          jsx("div", { style: styles.hint, children: "● — файл параметров есть, ○ — ещё не создан. Параметры открываются по клику на проект." }),
        ]}),
        jsx("datalist", { id: PLATFORM_LIST_ID, children: platforms.map((p) => jsx("option", { key: p.path, value: p.path, children: p.version })) }),
        jsx("datalist", { id: INFOBASE_LIST_ID, children: infoBases.map((b) => jsx("option", { key: b.value, value: b.value, children: b.name })) }),
        dialog,
      ]});
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "1c-project-properties",
            order: 55,
            label: () => "1С: Параметры проектов",
            registrant: "dsh-1c-project-properties",
          },
          Section,
        ),
      );
    }

    return { apply, inject: ["slots"] };
  },
});
