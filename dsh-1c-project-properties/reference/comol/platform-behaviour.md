<!-- источник: comol/ai_rules_1c @ ef070d1955289fa88440a8b85273cdf3b0c31a27 · content/skills/1c-qa-testing/docs/platform-behaviour.md · дословно, без правок -->

# Platform behaviour (8.3.27.2130, measured)

- **Idle link.** The test client drops a manager link that has been silent for 200 s. QA MCP after 0.7.2 and the platform manager keep the link alive; on 0.7.2 and earlier call `qa_reconnect(force=True)` after a pause of more than about 3 minutes. `qa_status` shows a lost link.
- **Typed text is applied when focus leaves the field.** `ui_input` / `ui_set` show the text at once; `OnChange` and its checks run on the next focus move, and their messages arrive with the next action's result. Before asserting a value that depends on the change, move focus (`ui_activate` the next field). Where the server returns `applied`, `value_before`, `value_after` and `verified`, use them; numbers compare as numbers (`100` = `100,00`).
- **A refused input carries its reason in the form messages.** A refusal from form code reaches the test client as a generic error: read `ui_messages` (newer servers append `Form messages: …` to the error).
- **Question or error.** A question or warning is form `MessageBox`; an unhandled exception is `ErrorWindow` titled «1С:Предприятие». After `ErrorWindow` call `ui_errors`: it gives the module, line, source line and cause chain. Newer servers report either window as `window_after`.
- **No message panel.** An empty or `panel_shown: false` answer of `ui_messages` does not prove there were no messages; the panel may have been closed.
- **Deleting in a dynamic list asks first.** `deleted: true` only means the command was accepted; answer the question with `ui_dialog`.
- **Rows are found by displayed text.** A number is matched as the table shows it: `7,000`, not `7`.
- **Tabs.** A table on an inactive tab can be read without switching the tab. `goto` and `select_row` make its tab current. Switch tabs with `ui_activate` on the page group; `ui_click` fails there.
- **A list form may hold several tables.** The main one is not always `Список`: find the tables with `ui_inspect` and pass `table=`.
- **Post / Write may finish later (seen on ERP).** On heavy documents `ui_click` returns once the client accepts the command. Confirm the result before asserting or closing: the title without «(создание)» and «*», the number in the title (`ui_wait` or a new read).
