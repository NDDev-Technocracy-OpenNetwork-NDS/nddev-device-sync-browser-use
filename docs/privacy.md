# Privacy policy: NDDev OpenNetwork NDS browser-use

Applies to the browser extension "NDDev OpenNetwork NDS browser-use" and to the NDS host it talks
to. [Русская версия ниже](#политика-конфиденциальности-nddev-opennetwork-nds-browser-use).

## What it does

The extension lets AI agents that **you** run on your own device work in your browser. Agents get
only the tabs in their own tab groups. Your other tabs stay out of their reach. The extension does
nothing until the NDS host, a program installed on the same device, connects to it.

## What it accesses

- **Tabs in agent tab groups.** Here the extension attaches Chrome's debugger. It reads and changes
  pages only when an agent asks it to, for example to read text, click, fill a form or take a
  screenshot. It never attaches to a tab outside an agent group.
- **Downloads started by agent tabs.** The NDS host moves each such file into the agent's session.
  The extension then removes that one download from your download folder and list. It never reads,
  changes or removes any other download.
- **Your own actions, only when you press "Record what I do".** Your clicks, typing and navigations
  in that agent tab are recorded, so the agent can learn a task. Recording stops when you press
  "Stop recording".
- **Settings.** The extension stores in the browser: agent control on or off, the observation
  profile, your private sites and the popup language.

## Where the data goes

- **Only to the NDS host on the same device**, through Chrome's native messaging. The extension
  sends nothing to NDDev, to any server or to any third party. It has no analytics and no ads, and it
  never sells or shares data.
- **The host gives results to the agent that asked for them.** Screenshots, downloads and
  recordings stay in that agent's session, on this device, and are deleted with the session.
- **The host keeps an activity journal of agent tabs on this device**, depending on the
  observation profile you choose in the popup:
  - **Full:** agent actions, pages, network requests and console errors, with secrets removed.
  - **Standard:** only names, timings and outcomes, with no page content.
  - **Off:** nothing.

  The journal is kept for one week and has a size limit. Sites you mark as private keep no content
  in it.
- **The host's telemetry** carries event names, outcomes and durations, never URLs or page content.
  It stays on this device, unless you connect the device to your own NDS observability.

## The agents you run

The agents are your choice, not part of the extension. What an agent reads in its tabs goes to
that agent. If you run an agent that uses an online AI service, that service's privacy policy
applies to what the agent sends it. Give agent groups only the sites you are willing to share
with the agent.

## Your control

- **The popup's switch** stops all agents at once and releases their tabs.
- **The observation profile** decides what the journal keeps, and **Off** stops collection.
- **Private sites** keep their content out of the journal, while agents still work there.
- **Uninstalling the extension** removes its settings. The host's data lives in its state
  directory on your device. Uninstall the host to remove it.

## Contact

Questions and requests go to
[GitHub issues](https://github.com/NDDev-Technocracy-OpenNetwork-NDS/nddev-device-sync-browser-use/issues).
Report security problems as described in [SECURITY.md](../SECURITY.md). Changes to this policy appear
in this file's history.

---

# Политика конфиденциальности NDDev OpenNetwork NDS browser-use

Распространяется на расширение браузера «NDDev OpenNetwork NDS browser-use» и на хост NDS, с
которым оно работает.

## Что оно делает

Расширение позволяет ИИ-агентам, которых **вы** запускаете на своём устройстве, работать в вашем
браузере. Агенты получают только вкладки из своих групп. Остальные вкладки для них недоступны. Пока
к расширению не подключится хост NDS (программа, установленная на этом же устройстве), оно ничего
не делает.

## К чему у него есть доступ

- **Вкладки из групп агентов.** К ним расширение подключает отладчик Chrome. Читает и меняет
  страницы оно только по запросу агента, например чтобы прочитать текст, нажать кнопку, заполнить
  форму или снять скриншот. К вкладкам вне групп агентов оно не подключается.
- **Загрузки, начатые во вкладках агентов.** Хост NDS переносит каждый такой файл в сессию агента.
  Затем расширение удаляет эту загрузку из вашей папки и списка загрузок. Другие загрузки оно не
  читает, не меняет и не удаляет.
- **Ваши собственные действия, только после кнопки «Записать мои действия».** Ваши щелчки, ввод и
  переходы в этой вкладке агента записываются, чтобы агент научился задаче. Запись прекращается по
  кнопке «Остановить запись».
- **Настройки.** Расширение хранит в браузере: включено ли управление агентами, профиль наблюдения,
  ваши приватные сайты и язык окна расширения.

## Куда идут данные

- **Только хосту NDS на этом же устройстве**, через native messaging Chrome. Расширение ничего не
  отправляет ни NDDev, ни на какой-либо сервер, ни третьим лицам. В нём нет аналитики и рекламы, и
  оно никогда не продаёт и не передаёт данные.
- **Хост отдаёт результаты тому агенту, который их запросил.** Скриншоты, загрузки и записи
  остаются в сессии этого агента на этом устройстве и удаляются вместе с сессией.
- **Хост ведёт на этом устройстве журнал действий во вкладках агентов**, в зависимости от профиля
  наблюдения, выбранного в окне расширения:
  - **«Полное»:** действия агентов, страницы, сетевые запросы и ошибки консоли, без секретов.
  - **«Стандарт»:** только названия, длительности и итоги, без содержимого страниц.
  - **«Выкл.»:** ничего.

  Журнал хранится одну неделю и ограничен по размеру. Для сайтов, отмеченных как приватные,
  содержимое в нём не сохраняется.
- **Телеметрия хоста** содержит названия событий, итоги и длительности и никогда не содержит URL или
  содержимого страниц. Она остаётся на этом устройстве, если вы сами не подключите его к своей
  системе наблюдения NDS.

## Агенты, которых вы запускаете

Агентов выбираете вы, они не входят в расширение. То, что агент читает в своих вкладках, получает
этот агент. Если ваш агент пользуется онлайн-сервисом ИИ, к тому, что агент ему отправляет,
применяется политика конфиденциальности этого сервиса. Открывайте в группах агентов только те сайты,
которые готовы показать агенту.

## Ваш контроль

- **Переключатель в окне расширения** сразу останавливает всех агентов и освобождает их вкладки.
- **Профиль наблюдения** определяет, что хранит журнал, а **«Выкл.»** прекращает сбор.
- **Приватные сайты** не попадают в журнал своим содержимым, хотя агенты продолжают там работать.
- **Удаление расширения** удаляет его настройки. Данные хоста хранятся в его каталоге состояния на
  вашем устройстве; чтобы удалить их, удалите хост.

## Связь

Вопросы и запросы направляйте в
[GitHub issues](https://github.com/NDDev-Technocracy-OpenNetwork-NDS/nddev-device-sync-browser-use/issues).
О проблемах безопасности сообщайте, как описано в [SECURITY.md](../SECURITY.md). Изменения этой политики
видны в истории этого файла.
