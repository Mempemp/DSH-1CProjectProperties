// Дополнительный набор, который можно добавить к нашим правилам флажком.
// Наши правила живут в playbook/ и разворачиваются всегда, поэтому реестра
// наборов здесь нет: есть один необязательный набор и его описание.

export const COMOL = Object.freeze({
  id: "comol",
  title: "Правила comol",
  payloadDir: "1c-rules",
  hint: "Правила, роли субагентов, команды, навыки и OpenSpec — нужны MCP-серверы comol.",
  repo: "https://github.com/comol/ai_rules_1c",
});
