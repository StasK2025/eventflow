'use strict';

/**
 * EventFlow — состояние интерфейса и рендеринг.
 *
 * Первый этап: запуск приложения, подключение к IndexedDB, показ настроек
 * события, показателей, таблицы участников и журнала, состояния
 * loading / empty / error / success.
 *
 * Второй этап: форма участника (создание и редактирование), проверка данных
 * с ошибками рядом с полями, карточка участника, архивация с отменой.
 *
 * Третий этап: импорт CSV без внешних библиотек — парсинг, проверка строк,
 * предпросмотр с ошибками и дубликатами, импорт корректных строк одной
 * транзакцией после подтверждения.
 *
 * Четвёртый этап: поиск по имени, email и компании, фильтры статуса и билета,
 * сортировка по имени и дате регистрации. Этап 4 выполнен.
 *
 * Пятый этап: экспорт полной резервной копии в JSON (schemaVersion 1) и
 * восстановление через проверку структуры и версии, предпросмотр и отдельное
 * подтверждение полной замены.
 *
 * Следующие этапы: отметка о прибытии из строки таблицы.
 */

(() => {
  const db = window.EventFlowDB;

  const elements = {
    eventName: document.getElementById('event-name'),
    eventMeta: document.getElementById('event-meta'),
    metricTotal: document.getElementById('metric-total'),
    metricConfirmed: document.getElementById('metric-confirmed'),
    metricCheckedin: document.getElementById('metric-checkedin'),
    metricWaitlist: document.getElementById('metric-waitlist'),
    participantsBody: document.getElementById('participants-body'),
    tableWrap: document.getElementById('table-wrap'),
    stateLoading: document.getElementById('state-loading'),
    stateEmpty: document.getElementById('state-empty'),
    stateEmptySearch: document.getElementById('state-empty-search'),
    stateError: document.getElementById('state-error'),
    stateErrorMessage: document.getElementById('state-error-message'),
    retryButton: document.getElementById('retry-button'),
    activityList: document.getElementById('activity-list'),
    activityEmpty: document.getElementById('activity-empty'),
    filterStatus: document.getElementById('filter-status'),
    filterTicket: document.getElementById('filter-ticket'),
    searchInput: document.getElementById('search-input'),
    sortSelect: document.getElementById('sort-select'),
    fieldTicket: document.getElementById('field-ticket'),
    fieldStatus: document.getElementById('field-status'),
    toastRegion: document.getElementById('toast-region'),
    dialogParticipant: document.getElementById('dialog-participant'),
    dialogParticipantTitle: document.getElementById('dialog-participant-title'),
    participantForm: document.getElementById('participant-form'),
    participantSave: document.querySelector('#participant-form button[type="submit"]'),
    dialogDetails: document.getElementById('dialog-details'),
    detailsList: document.getElementById('details-list'),
    dialogImport: document.getElementById('dialog-import'),
    importFile: document.getElementById('import-file'),
    importFileError: document.getElementById('import-file-error'),
    importPreview: document.getElementById('import-preview'),
    importColumns: document.getElementById('import-columns'),
    importTotal: document.getElementById('import-total'),
    importValid: document.getElementById('import-valid'),
    importErrorsCount: document.getElementById('import-errors-count'),
    importDuplicatesCount: document.getElementById('import-duplicates-count'),
    importDuplicates: document.getElementById('import-duplicates'),
    importErrorsList: document.getElementById('import-errors-list'),
    importConfirm: document.getElementById('import-confirm'),
    dialogRestore: document.getElementById('dialog-restore'),
    restoreFile: document.getElementById('restore-file'),
    restoreFileError: document.getElementById('restore-file-error'),
    restoreStatus: document.getElementById('restore-status'),
    restorePreview: document.getElementById('restore-preview'),
    restoreEventName: document.getElementById('restore-event-name'),
    restoreParticipantsCount: document.getElementById('restore-participants-count'),
    restoreActivityCount: document.getElementById('restore-activity-count'),
    restoreConfirmCheckbox: document.getElementById('restore-confirm-checkbox'),
    restoreConfirm: document.getElementById('restore-confirm'),
  };

  // Поля формы и области сообщений об ошибках рядом с ними
  const fieldInputs = {
    name: document.getElementById('field-name'),
    email: document.getElementById('field-email'),
    company: document.getElementById('field-company'),
    ticket: document.getElementById('field-ticket'),
    status: document.getElementById('field-status'),
    checkedIn: document.getElementById('field-checked-in'),
  };
  const fieldErrors = {
    name: document.getElementById('error-name'),
    email: document.getElementById('error-email'),
    company: document.getElementById('error-company'),
    ticket: document.getElementById('error-ticket'),
    status: document.getElementById('error-status'),
    checkedIn: document.getElementById('error-checkedIn'),
  };

  const state = {
    settings: null,
    participants: [],
    activity: [],
    editingId: null,
    currentParticipantId: null,
    touched: new Set(),
    emailDuplicate: false,
    importPreview: null,
    restorePreview: null,
    view: {
      query: '',
      status: 'all',
      ticket: 'all',
      sort: 'registered-desc',
    },
  };

  // ------------------------------------------------------------------
  // Форматирование
  // ------------------------------------------------------------------

  function formatDateTime(iso) {
    if (!iso) {
      return '—';
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    const pad = (value) => String(value).padStart(2, '0');
    return pad(date.getDate()) + '.' + pad(date.getMonth() + 1) + '.' + date.getFullYear() +
      ', ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function getInitials(name) {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return '?';
    }
    return parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('');
  }

  function statusLabel(value) {
    const list = state.settings ? state.settings.statuses : [];
    const found = list.find((status) => status.value === value);
    return found ? found.label : value;
  }

  function ticketLabel(value) {
    const list = state.settings ? state.settings.tickets : [];
    const found = list.find((ticket) => ticket.value === value);
    return found ? found.label : value;
  }

  // ------------------------------------------------------------------
  // Состояния списка
  // ------------------------------------------------------------------

  function showState(name) {
    elements.stateLoading.hidden = name !== 'loading';
    elements.stateEmpty.hidden = name !== 'empty';
    elements.stateEmptySearch.hidden = name !== 'empty-search';
    elements.stateError.hidden = name !== 'error';
    elements.tableWrap.hidden = name !== 'ready';
  }

  function showError(error) {
    elements.stateErrorMessage.textContent =
      (error && error.message) || 'Произошла неизвестная ошибка. Повторите попытку.';
    showState('error');
  }

  // ------------------------------------------------------------------
  // Уведомления
  // ------------------------------------------------------------------

  function showToast(message, kind, action) {
    const toast = document.createElement('div');
    toast.className = 'toast toast--' + (kind || 'success');
    toast.setAttribute('role', 'status');

    const text = document.createElement('p');
    text.className = 'toast__text';
    text.textContent = message;
    toast.appendChild(text);

    if (action && typeof action.onClick === 'function') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toast__action';
      button.textContent = action.label || 'Отменить';
      button.addEventListener('click', () => {
        action.onClick();
        toast.remove();
      });
      toast.appendChild(button);
    }

    elements.toastRegion.appendChild(toast);
    // Уведомления с действием (например, «Отменить») живут дольше
    window.setTimeout(() => toast.remove(), action ? 8000 : 5000);
  }

  // ------------------------------------------------------------------
  // Рендеринг
  // ------------------------------------------------------------------

  function renderHeader() {
    const event = state.settings.event;
    elements.eventName.textContent = event.name;
    const meta = [];
    if (event.venue) {
      meta.push(event.venue);
    }
    if (event.capacity !== undefined && event.capacity !== null) {
      meta.push('Вместимость: ' + event.capacity);
    }
    elements.eventMeta.textContent = meta.length ? meta.join(' · ') : 'Настройки события';
  }

  function fillSelect(select, placeholder, items) {
    select.textContent = '';
    if (placeholder) {
      const option = document.createElement('option');
      option.value = placeholder.value;
      option.textContent = placeholder.label;
      select.appendChild(option);
    }
    items.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      select.appendChild(option);
    });
  }

  /** Значения выпадающих списков берутся из хранилища settings. */
  function renderSelectOptions() {
    fillSelect(elements.filterStatus, { value: 'all', label: 'Все статусы' }, state.settings.statuses);
    fillSelect(elements.filterTicket, { value: 'all', label: 'Все билеты' }, state.settings.tickets);
    fillSelect(elements.fieldStatus, { value: '', label: 'Выберите статус' }, state.settings.statuses);
    fillSelect(elements.fieldTicket, { value: '', label: 'Выберите тип билета' }, state.settings.tickets);
  }

  function renderMetrics() {
    const active = state.participants.filter((participant) => !participant.archivedAt);
    elements.metricTotal.textContent = String(active.length);
    elements.metricConfirmed.textContent =
      String(active.filter((participant) => participant.status === 'confirmed').length);
    elements.metricCheckedin.textContent =
      String(active.filter((participant) => participant.checkedIn === true).length);
    elements.metricWaitlist.textContent =
      String(active.filter((participant) => participant.status === 'waitlist').length);
  }

  function buildParticipantRow(participant) {
    const row = document.createElement('tr');

    // Участник
    const cellPerson = document.createElement('td');
    const personWrap = document.createElement('div');
    personWrap.className = 'participant-cell';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = getInitials(participant.name);

    const personText = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'participant-cell__name';
    name.textContent = participant.name;
    const email = document.createElement('p');
    email.className = 'participant-cell__email';
    email.textContent = participant.email;
    personText.appendChild(name);
    personText.appendChild(email);
    if (participant.company) {
      const company = document.createElement('p');
      company.className = 'participant-cell__company';
      company.textContent = participant.company;
      personText.appendChild(company);
    }

    personWrap.appendChild(avatar);
    personWrap.appendChild(personText);
    cellPerson.appendChild(personWrap);
    row.appendChild(cellPerson);

    // Билет
    const cellTicket = document.createElement('td');
    cellTicket.dataset.label = 'Билет';
    cellTicket.textContent = ticketLabel(participant.ticket);
    row.appendChild(cellTicket);

    // Статус
    const cellStatus = document.createElement('td');
    cellStatus.dataset.label = 'Статус';
    const pill = document.createElement('span');
    pill.className = 'pill pill--' + participant.status;
    pill.textContent = statusLabel(participant.status);
    cellStatus.appendChild(pill);
    row.appendChild(cellStatus);

    // Регистрация
    const cellRegistered = document.createElement('td');
    cellRegistered.dataset.label = 'Регистрация';
    cellRegistered.textContent = formatDateTime(participant.registeredAt);
    row.appendChild(cellRegistered);

    // Чек-ин
    const cellCheckin = document.createElement('td');
    cellCheckin.dataset.label = 'Чек-ин';
    if (participant.checkedIn === true) {
      const checked = document.createElement('span');
      checked.className = 'pill pill--checked';
      checked.textContent = 'Пришёл';
      cellCheckin.appendChild(checked);
    } else if (participant.status === 'confirmed') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--secondary btn--small';
      button.dataset.action = 'checkin';
      button.dataset.id = participant.id;
      button.textContent = 'Отметить приход';
      cellCheckin.appendChild(button);
    } else {
      const none = document.createElement('span');
      none.className = 'cell-muted';
      none.textContent = '—';
      none.title = 'Чек-ин доступен только для подтверждённых участников';
      cellCheckin.appendChild(none);
    }
    row.appendChild(cellCheckin);

    // Действия
    const cellActions = document.createElement('td');
    cellActions.dataset.label = 'Действия';
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    [
      { action: 'open-participant', label: 'Открыть' },
      { action: 'edit-participant', label: 'Изменить' },
      { action: 'archive-participant', label: 'Архивировать' },
    ].forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--secondary btn--small';
      button.dataset.action = item.action;
      button.dataset.id = participant.id;
      button.textContent = item.label;
      actions.appendChild(button);
    });
    cellActions.appendChild(actions);
    row.appendChild(cellActions);

    return row;
  }

  /** Сортировка по выбору пользователя: имя или дата регистрации. */
  function sortParticipants(participants) {
    const mode = state.view.sort;
    const sorted = participants.slice();
    sorted.sort((a, b) => {
      if (mode === 'name-asc') {
        return String(a.name).localeCompare(String(b.name), 'ru');
      }
      if (mode === 'name-desc') {
        return String(b.name).localeCompare(String(a.name), 'ru');
      }
      if (mode === 'registered-asc') {
        return String(a.registeredAt).localeCompare(String(b.registeredAt));
      }
      // registered-desc: сначала новые
      return String(b.registeredAt).localeCompare(String(a.registeredAt));
    });
    return sorted;
  }

  /** Поиск по имени, email и компании + фильтры статуса и билета. */
  function filterParticipants(participants) {
    const query = state.view.query.trim().toLowerCase();
    return participants.filter((participant) => {
      if (state.view.status !== 'all' && participant.status !== state.view.status) {
        return false;
      }
      if (state.view.ticket !== 'all' && participant.ticket !== state.view.ticket) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [participant.name, participant.email, participant.company]
        .some((value) => String(value || '').toLowerCase().includes(query));
    });
  }

  function renderParticipants() {
    const active = state.participants.filter((participant) => !participant.archivedAt);
    const visible = sortParticipants(filterParticipants(active));

    elements.participantsBody.textContent = '';
    visible.forEach((participant) => {
      elements.participantsBody.appendChild(buildParticipantRow(participant));
    });

    if (visible.length > 0) {
      showState('ready');
    } else if (active.length > 0) {
      // Участники есть, но условия поиска/фильтров их исключили
      showState('empty-search');
    } else {
      showState('empty');
    }
  }

  // Цветовой акцент записи журнала по типу действия
  const ACTIVITY_KINDS = {
    create: 'primary',
    update: 'primary',
    export: 'primary',
    checkin: 'success',
    checkout: 'success',
    import: 'success',
    restore: 'success',
    'restore-backup': 'success',
    'undo-restore': 'success',
    archive: 'warning',
  };

  function renderActivity() {
    elements.activityList.textContent = '';
    elements.activityEmpty.hidden = state.activity.length > 0;

    state.activity.forEach((entry) => {
      const item = document.createElement('li');
      item.className = 'activity-item activity-item--' + (ACTIVITY_KINDS[entry.type] || 'primary');

      const title = document.createElement('p');
      title.className = 'activity-item__title';
      title.textContent = entry.title;

      const details = document.createElement('p');
      details.className = 'activity-item__details';
      details.textContent = entry.details || '';

      const time = document.createElement('p');
      time.className = 'activity-item__time';
      time.textContent = formatDateTime(entry.at);

      item.appendChild(title);
      item.appendChild(details);
      item.appendChild(time);

      // У записи об архивации есть «Восстановить», пока участник в архиве:
      // отмена доступна не только из уведомления, но и позже.
      if (entry.type === 'archive' && entry.meta && entry.meta.participantId) {
        const participant = state.participants.find(
          (candidate) => candidate.id === entry.meta.participantId
        );
        if (participant && participant.archivedAt) {
          const restoreButton = document.createElement('button');
          restoreButton.type = 'button';
          restoreButton.className = 'btn btn--ghost btn--small';
          restoreButton.dataset.action = 'undo-archive';
          restoreButton.dataset.id = entry.meta.participantId;
          restoreButton.textContent = 'Восстановить';
          item.appendChild(restoreButton);
        }
      }

      // Восстановление копии тоже можно отменить прямо из журнала
      if (entry.type === 'restore-backup' && entry.meta && entry.meta.snapshot) {
        const undoButton = document.createElement('button');
        undoButton.type = 'button';
        undoButton.className = 'btn btn--ghost btn--small';
        undoButton.dataset.action = 'undo-restore-backup';
        undoButton.dataset.id = String(entry.id);
        undoButton.textContent = 'Отменить восстановление';
        item.appendChild(undoButton);
      }

      elements.activityList.appendChild(item);
    });
  }

  // ------------------------------------------------------------------
  // Ошибки полей формы
  // ------------------------------------------------------------------

  function clearFieldError(field) {
    const errorElement = fieldErrors[field];
    if (errorElement) {
      errorElement.textContent = '';
      errorElement.hidden = true;
    }
    const input = fieldInputs[field];
    if (input) {
      input.removeAttribute('aria-invalid');
    }
  }

  function showFieldError(field, message) {
    const errorElement = fieldErrors[field];
    if (errorElement) {
      errorElement.textContent = message;
      errorElement.hidden = false;
    }
    const input = fieldInputs[field];
    if (input) {
      input.setAttribute('aria-invalid', 'true');
    }
  }

  function clearAllFieldErrors() {
    Object.keys(fieldInputs).forEach((field) => clearFieldError(field));
  }

  // ------------------------------------------------------------------
  // Форма участника: создание и редактирование
  // ------------------------------------------------------------------

  function readFormValues() {
    return {
      name: fieldInputs.name.value,
      email: fieldInputs.email.value,
      company: fieldInputs.company.value,
      ticket: fieldInputs.ticket.value,
      status: fieldInputs.status.value,
      checkedIn: fieldInputs.checkedIn.checked,
    };
  }

  /**
   * Проверка формы. Ошибки показываются рядом с полями: для затронутых
   * полей — сразу, для остальных — после первой попытки сохранения.
   * Кнопка сохранения недоступна, пока данные заведомо неверны.
   */
  function refreshFormValidation(revealAll) {
    const values = readFormValues();
    const errors = db.validateParticipant(values, state.settings);
    const byField = {};
    errors.forEach((error) => {
      byField[error.field] = error.message;
    });
    if (state.emailDuplicate && !byField.email) {
      byField.email =
        'Этот email уже используется другим участником — измените email или откройте существующую запись.';
    }

    Object.keys(fieldInputs).forEach((field) => {
      const message = byField[field];
      const shouldReveal = revealAll || state.touched.has(field) ||
        (field === 'email' && state.emailDuplicate);
      if (message && shouldReveal) {
        showFieldError(field, message);
      } else {
        clearFieldError(field);
      }
    });

    elements.participantSave.disabled = errors.length > 0 || state.emailDuplicate;
    return errors;
  }

  /** Чек-ин в форме доступен только для статуса «Подтверждён». */
  function updateCheckedInAvailability() {
    const input = fieldInputs.checkedIn;
    const confirmed = fieldInputs.status.value === 'confirmed';
    input.disabled = !confirmed;
    if (!confirmed) {
      input.checked = false;
    }
  }

  function resetForm() {
    elements.participantForm.reset();
    state.touched = new Set();
    state.emailDuplicate = false;
    clearAllFieldErrors();
    updateCheckedInAvailability();
  }

  function openCreateForm() {
    resetForm();
    state.editingId = null;
    elements.dialogParticipantTitle.textContent = 'Новый участник';
    elements.participantSave.textContent = 'Сохранить';
    refreshFormValidation(false);
    elements.dialogParticipant.showModal();
    fieldInputs.name.focus();
  }

  async function openEditForm(id) {
    let participant = null;
    try {
      participant = await db.getParticipantById(id);
    } catch (error) {
      showToast(error.message || 'Не удалось загрузить участника', 'error');
      return;
    }
    if (!participant) {
      showToast('Участник не найден. Обновите список.', 'error');
      return;
    }
    resetForm();
    state.editingId = participant.id;
    elements.dialogParticipantTitle.textContent = 'Изменение участника';
    elements.participantSave.textContent = 'Сохранить изменения';
    fieldInputs.name.value = participant.name;
    fieldInputs.email.value = participant.email;
    fieldInputs.company.value = participant.company || '';
    fieldInputs.ticket.value = participant.ticket;
    fieldInputs.status.value = participant.status;
    fieldInputs.checkedIn.checked = participant.checkedIn === true;
    updateCheckedInAvailability();
    refreshFormValidation(false);
    elements.dialogParticipant.showModal();
    fieldInputs.name.focus();
  }

  /**
   * Проверка уникальности email (без учёта регистра). Результат применяется,
   * только если пользователь не успел изменить поле.
   */
  async function checkEmailUniqueness() {
    const values = readFormValues();
    const emailErrors = db
      .validateParticipant(values, state.settings)
      .filter((error) => error.field === 'email');
    if (emailErrors.length > 0) {
      state.emailDuplicate = false;
      refreshFormValidation(false);
      return false;
    }

    const normalized = db.normalizeEmail(values.email);
    try {
      const existing = await db.getParticipantByEmail(normalized);
      if (db.normalizeEmail(fieldInputs.email.value) !== normalized) {
        return false; // значение уже изменилось, результат устарел
      }
      state.emailDuplicate = Boolean(existing) && existing.id !== state.editingId;
    } catch (error) {
      // Сбой проверки не блокирует форму: дубликат отклонит база
      state.emailDuplicate = false;
    }
    refreshFormValidation(false);
    return !state.emailDuplicate;
  }

  /** Сохранение: форма → проверка → база → экран. */
  async function handleSubmit(event) {
    event.preventDefault();

    const errors = refreshFormValidation(true);
    if (errors.length > 0) {
      const firstInput = fieldInputs[errors[0].field];
      if (firstInput) {
        firstInput.focus();
      }
      return;
    }

    const unique = await checkEmailUniqueness();
    if (!unique) {
      fieldInputs.email.focus();
      return;
    }

    const values = readFormValues();
    const isEdit = Boolean(state.editingId);
    elements.participantSave.disabled = true;
    try {
      if (isEdit) {
        await db.updateParticipant(state.editingId, values);
      } else {
        await db.addParticipant(values);
      }
      elements.dialogParticipant.close();
      resetForm();
      state.editingId = null;
      await refreshData();
      showToast(isEdit ? 'Изменения сохранены' : 'Участник добавлен', 'success');
    } catch (error) {
      if (error && error.name === 'ValidationError' && error.errors) {
        error.errors.forEach((item) => showFieldError(item.field, item.message));
      } else {
        const message = (error && error.message) || 'Не удалось сохранить участника';
        showToast(message, 'error');
        if (/email/i.test(message)) {
          showFieldError('email', message);
        }
      }
    } finally {
      refreshFormValidation(false);
    }
  }

  // ------------------------------------------------------------------
  // Карточка участника
  // ------------------------------------------------------------------

  async function openDetails(id) {
    let participant = null;
    try {
      participant = await db.getParticipantById(id);
    } catch (error) {
      showToast(error.message || 'Не удалось открыть карточку участника', 'error');
      return;
    }
    if (!participant) {
      showToast('Участник не найден. Обновите список.', 'error');
      return;
    }

    state.currentParticipantId = participant.id;
    elements.detailsList.textContent = '';
    const rows = [
      ['Имя', participant.name],
      ['Email', participant.email],
      ['Компания', participant.company || '—'],
      ['Билет', ticketLabel(participant.ticket)],
      ['Статус', statusLabel(participant.status)],
      ['Регистрация', formatDateTime(participant.registeredAt)],
      ['Чек-ин', participant.checkedIn === true ? 'Пришёл' : 'Не отмечен'],
    ];
    if (participant.archivedAt) {
      rows.push(['В архиве с', formatDateTime(participant.archivedAt)]);
    }
    rows.forEach((row) => {
      const term = document.createElement('dt');
      term.textContent = row[0];
      const description = document.createElement('dd');
      description.textContent = row[1];
      elements.detailsList.appendChild(term);
      elements.detailsList.appendChild(description);
    });

    elements.dialogDetails.showModal();
  }

  // ------------------------------------------------------------------
  // Архивация и отмена
  // ------------------------------------------------------------------

  async function archiveWithUndo(id) {
    let participant = null;
    try {
      participant = await db.getParticipantById(id);
      if (!participant) {
        showToast('Участник не найден. Обновите список.', 'error');
        return;
      }
      await db.archiveParticipant(id);
      await refreshData();
      showToast('Участник «' + participant.name + '» заархивирован', 'warning', {
        label: 'Отменить',
        onClick: () => undoArchive(id),
      });
    } catch (error) {
      showToast(error.message || 'Не удалось заархивировать участника', 'error');
    }
  }

  async function undoArchive(id) {
    try {
      await db.restoreParticipant(id);
      await refreshData();
      showToast('Архивация отменена', 'success');
    } catch (error) {
      showToast(error.message || 'Не удалось отменить архивацию', 'error');
    }
  }

  // ------------------------------------------------------------------
  // Импорт CSV
  // ------------------------------------------------------------------

  // Соответствие заголовков CSV полям модели (файлы из data/)
  const CSV_COLUMNS = {
    name: 'name',
    email: 'email',
    company: 'company',
    ticket: 'ticket',
    status: 'status',
    checked_in: 'checkedIn',
    registered_at: 'registeredAt',
  };
  const CSV_REQUIRED_COLUMNS = ['name', 'email', 'ticket', 'status', 'checked_in', 'registered_at'];

  /**
   * Разбор CSV без внешних библиотек (по мотивам RFC 4180): кавычки,
   * "" внутри кавычек, запятые и переводы строк внутри кавычек,
   * CRLF/LF, BOM. Возвращает записи с номерами физических строк
   * (заголовок — строка 1), пустые строки пропускаются.
   */
  function parseCsv(text) {
    const source = text.replace(/^\uFEFF/, '');
    const records = [];
    let values = [];
    let field = '';
    let inQuotes = false;
    let line = 1;
    let recordLine = 1;

    const endField = () => {
      values.push(field);
      field = '';
    };
    const endRecord = () => {
      endField();
      const isBlank = values.length === 1 && values[0].trim() === '';
      if (!isBlank) {
        records.push({ line: recordLine, values });
      }
      values = [];
    };

    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (inQuotes) {
        if (char === '"') {
          if (source[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          if (char === '\n') {
            line += 1;
          }
          field += char;
        }
        continue;
      }
      if (char === '"') {
        inQuotes = true;
        continue;
      }
      if (char === ',') {
        endField();
        continue;
      }
      if (char === '\r') {
        continue;
      }
      if (char === '\n') {
        endRecord();
        line += 1;
        recordLine = line;
        continue;
      }
      field += char;
    }
    if (field !== '' || values.length > 0) {
      endRecord();
    }
    return records;
  }

  /** Чтение файла как текста (UTF-8). */
  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Не удалось прочитать файл.'));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(file, 'UTF-8');
    });
  }

  /** Сопоставление строки CSV полям модели + проверки формата значений. */
  function mapCsvRow(record, columnIndexes) {
    const at = (key) => {
      const index = columnIndexes[key];
      const value = index === undefined ? '' : record.values[index];
      return String(value === undefined || value === null ? '' : value).trim();
    };

    const csvErrors = [];
    const checkedInRaw = at('checkedIn').toLowerCase();
    let checkedIn = false;
    if (checkedInRaw === 'true') {
      checkedIn = true;
    } else if (checkedInRaw === 'false') {
      checkedIn = false;
    } else if (checkedInRaw === '') {
      csvErrors.push('Обязательное поле «checked_in» пустое.');
    } else {
      csvErrors.push('Некорректное значение «' + at('checkedIn') +
        '» в столбце checked_in. Ожидается true или false.');
    }

    const registeredAt = at('registeredAt');
    if (!registeredAt) {
      csvErrors.push('Обязательное поле «registered_at» пустое.');
    }

    return {
      line: record.line,
      data: {
        name: at('name'),
        email: at('email'),
        company: at('company'),
        ticket: at('ticket'),
        status: at('status'),
        checkedIn,
        registeredAt,
      },
      csvErrors,
    };
  }

  /**
   * Проверка строки CSV. Правила — те же, что у формы (db.validateParticipant),
   * но сообщения адаптированы для файла: указывают столбец и допустимые значения.
   */
  function validateCsvRow(row, settings) {
    const messages = row.csvErrors.slice();
    const data = row.data;

    db.validateParticipant(data, settings).forEach((error) => {
      if (error.field === 'name' && !data.name) {
        messages.push('Обязательное поле «name» пустое.');
      } else if (error.field === 'email' && !data.email) {
        messages.push('Обязательное поле «email» пустое.');
      } else if (error.field === 'ticket' && !data.ticket) {
        messages.push('Обязательное поле «ticket» пустое.');
      } else if (error.field === 'ticket') {
        messages.push('Недопустимый тип билета «' + data.ticket + '» в столбце ticket. Допустимые значения: ' +
          settings.tickets.map((ticket) => ticket.label).join(', ') + '.');
      } else if (error.field === 'status' && !data.status) {
        messages.push('Обязательное поле «status» пустое.');
      } else if (error.field === 'status') {
        messages.push('Недопустимый статус «' + data.status + '» в столбце status. Допустимые значения: ' +
          settings.statuses.map((status) => status.label).join(', ') + '.');
      } else if (error.field === 'checkedIn') {
        messages.push('Нарушение правила чек-ина: checked_in=true допустим только для статуса «Подтверждён».');
      } else {
        messages.push(error.message);
      }
    });

    return messages;
  }

  /**
   * Построение модели предпросмотра. База данных не меняется.
   * - email, повторяющийся во входном файле, делает ошибочными обе строки:
   *   приоритет определить невозможно, поэтому ни одна не импортируется;
   * - email, уже существующий в базе, — строка корректна, при импорте
   *   существующая запись обновляется (дубликаты по email не создаются).
   */
  function buildImportPreview(text, settings, knownEmails, fileName) {
    const records = parseCsv(text);
    if (records.length === 0) {
      throw new Error('Файл пуст или не содержит данных.');
    }

    const headerLabels = records[0].values.map((value) => String(value).trim());
    const header = headerLabels.map((value) => value.toLowerCase());
    const columnIndexes = {};
    header.forEach((name, index) => {
      const field = CSV_COLUMNS[name];
      if (field && columnIndexes[field] === undefined) {
        columnIndexes[field] = index;
      }
    });

    const missing = CSV_REQUIRED_COLUMNS.filter((name) => columnIndexes[CSV_COLUMNS[name]] === undefined);
    if (missing.length > 0) {
      throw new Error('В файле нет обязательных столбцов: ' + missing.join(', ') + '.');
    }
    const unknownColumns = headerLabels.filter((label, index) => !CSV_COLUMNS[header[index]]);

    const rows = records.slice(1).map((record) => {
      const row = mapCsvRow(record, columnIndexes);
      row.errors = validateCsvRow(row, settings);
      row.duplicate = null;
      row.note = '';
      return row;
    });

    // Дубликаты во входном файле: помечаются все строки группы
    const byEmail = new Map();
    rows.forEach((row) => {
      const key = db.normalizeEmail(row.data.email);
      if (!key) {
        return;
      }
      if (!byEmail.has(key)) {
        byEmail.set(key, []);
      }
      byEmail.get(key).push(row);
    });
    byEmail.forEach((group) => {
      if (group.length > 1) {
        const lines = group.map((row) => row.line).join(', ');
        group.forEach((row) => {
          row.duplicate = 'file';
          row.errors.push('Email ' + row.data.email + ' повторяется в файле (строки ' + lines +
            ') — уберите дубликат, оставьте одну запись.');
        });
      }
    });

    // Дубликаты с базой: строка корректна, существующая запись будет обновлена
    rows.forEach((row) => {
      const key = db.normalizeEmail(row.data.email);
      if (row.duplicate === null && key && knownEmails.has(key)) {
        row.duplicate = 'db';
        row.note = 'Дубликат по email: запись в базе будет обновлена.';
      }
    });

    const validRows = rows.filter((row) => row.errors.length === 0);
    return {
      fileName,
      headerLabels,
      unknownColumns,
      rows,
      validRows: validRows.map((row) => row.data),
      counts: {
        total: rows.length,
        valid: validRows.length,
        errors: rows.length - validRows.length,
        duplicates: rows.filter((row) => row.duplicate !== null).length,
      },
    };
  }

  /** Отрисовка предпросмотра: столбцы, счётчики, дубликаты и ошибки. */
  function renderImportPreview(preview) {
    elements.importColumns.textContent = preview.headerLabels.join(', ') +
      (preview.unknownColumns.length > 0
        ? ' (не используются: ' + preview.unknownColumns.join(', ') + ')'
        : '');

    elements.importTotal.textContent = String(preview.counts.total);
    elements.importValid.textContent = String(preview.counts.valid);
    elements.importErrorsCount.textContent = String(preview.counts.errors);
    elements.importDuplicatesCount.textContent = String(preview.counts.duplicates);

    // Возможные дубликаты по email
    elements.importDuplicates.textContent = '';
    const duplicates = preview.rows.filter((row) => row.duplicate !== null);
    if (duplicates.length > 0) {
      const list = document.createElement('ul');
      duplicates.forEach((row) => {
        const item = document.createElement('li');
        item.textContent = 'Строка ' + row.line + ': ' + (row.note || row.errors[row.errors.length - 1]);
        list.appendChild(item);
      });
      elements.importDuplicates.appendChild(list);
      elements.importDuplicates.hidden = false;
    } else {
      elements.importDuplicates.hidden = true;
    }

    // Ошибки: номер строки и понятная причина
    elements.importErrorsList.textContent = '';
    preview.rows
      .filter((row) => row.errors.length > 0)
      .forEach((row) => {
        const tableRow = document.createElement('tr');
        const lineCell = document.createElement('td');
        lineCell.textContent = String(row.line);
        const reasonCell = document.createElement('td');
        reasonCell.textContent = row.errors.join(' ');
        tableRow.appendChild(lineCell);
        tableRow.appendChild(reasonCell);
        elements.importErrorsList.appendChild(tableRow);
      });

    elements.importConfirm.disabled = preview.validRows.length === 0;
    elements.importConfirm.textContent = preview.validRows.length > 0
      ? 'Импортировать корректные строки (' + preview.validRows.length + ')'
      : 'Импортировать корректные строки';
    elements.importPreview.hidden = false;
  }

  function showImportFileError(message) {
    elements.importFileError.textContent = message;
    elements.importFileError.hidden = false;
    elements.importPreview.hidden = true;
    elements.importConfirm.disabled = true;
    state.importPreview = null;
  }

  function hideImportFileError() {
    elements.importFileError.textContent = '';
    elements.importFileError.hidden = true;
  }

  function resetImportDialog() {
    state.importPreview = null;
    hideImportFileError();
    elements.importFile.value = '';
    elements.importPreview.hidden = true;
    elements.importColumns.textContent = '—';
    elements.importTotal.textContent = '0';
    elements.importValid.textContent = '0';
    elements.importErrorsCount.textContent = '0';
    elements.importDuplicatesCount.textContent = '0';
    elements.importDuplicates.textContent = '';
    elements.importDuplicates.hidden = true;
    elements.importErrorsList.textContent = '';
    elements.importConfirm.disabled = true;
    elements.importConfirm.textContent = 'Импортировать корректные строки';
  }

  function openImportDialog() {
    resetImportDialog();
    elements.dialogImport.showModal();
    elements.importFile.focus();
  }

  /**
   * Выбор файла: чтение, разбор и проверка строк, показ предпросмотра.
   * До подтверждения база данных не меняется.
   */
  async function handleImportFile() {
    const file = elements.importFile.files[0];
    if (!file) {
      return;
    }
    hideImportFileError();

    let text;
    try {
      text = await readFileText(file);
    } catch (error) {
      showImportFileError(error.message || 'Не удалось прочитать файл.');
      return;
    }

    try {
      const settings = state.settings || await db.getSettings();
      const known = await db.getAllParticipants();
      const knownEmails = new Set(known.map((participant) => db.normalizeEmail(participant.email)));
      const preview = buildImportPreview(text, settings, knownEmails, file.name);
      state.importPreview = preview;
      renderImportPreview(preview);
    } catch (error) {
      showImportFileError(error.message || 'Не удалось разобрать CSV-файл.');
    }
  }

  /** Подтверждение: импорт только корректных строк одной транзакцией. */
  async function confirmImport() {
    const preview = state.importPreview;
    if (!preview || preview.validRows.length === 0) {
      return;
    }
    elements.importConfirm.disabled = true;
    try {
      const result = await db.importParticipants(preview.validRows, {
        fileName: preview.fileName,
        skipped: preview.counts.errors,
      });
      elements.dialogImport.close();
      resetImportDialog();
      await refreshData();
      showToast('Импорт завершён: добавлено ' + result.added + ', обновлено ' + result.updated, 'success');
    } catch (error) {
      showToast(error.message || 'Не удалось импортировать данные', 'error');
      elements.importConfirm.disabled = preview.validRows.length === 0;
    }
  }

  // ------------------------------------------------------------------
  // Резервные копии (JSON)
  // ------------------------------------------------------------------

  const BACKUP_SCHEMA_VERSION = 1;

  /** Имя файла резервной копии. */
  function buildBackupFileName() {
    return 'eventflow-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  }

  /**
   * Экспорт: сбор данных и скачивание JSON-файла локально.
   * Файл никуда не отправляется — только сохраняется на диск.
   */
  async function exportBackup() {
    try {
      const data = await db.getBackup();
      const backup = {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        event: data.event,
        participants: data.participants,
        activity: data.activity,
      };
      const fileName = buildBackupFileName();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);

      await db.addActivity({
        type: 'export',
        title: 'Экспорт резервной копии',
        details: 'Участников: ' + backup.participants.length + ', записей журнала: ' + backup.activity.length,
        meta: { fileName },
      });
      await refreshData();
      showToast('Резервная копия «' + fileName + '» сохранена', 'success');
    } catch (error) {
      showToast(error.message || 'Не удалось создать резервную копию', 'error');
    }
  }

  /**
   * Проверка структуры и версии файла резервной копии.
   * Записи участников проходят тот же валидатор, что и форма.
   * Возвращает нормализованную копию или бросает ошибку с причиной.
   */
  function validateBackup(parsed, settings) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Файл не является резервной копией EventFlow: ожидается JSON-объект.');
    }
    if (parsed.schemaVersion === undefined) {
      throw new Error('В файле нет свойства schemaVersion — это не резервная копия EventFlow.');
    }
    if (parsed.schemaVersion !== BACKUP_SCHEMA_VERSION) {
      throw new Error('Несовместимая версия копии: ' + parsed.schemaVersion +
        '. Приложение поддерживает версию ' + BACKUP_SCHEMA_VERSION + '.');
    }
    if (!parsed.event || typeof parsed.event !== 'object' ||
        typeof parsed.event.name !== 'string' || !parsed.event.name.trim()) {
      throw new Error('В файле нет корректных настроек события (свойство event с названием).');
    }
    if (!Array.isArray(parsed.participants) || !Array.isArray(parsed.activity)) {
      throw new Error('Свойства participants и activity должны быть массивами.');
    }

    const errors = [];
    const seenEmails = new Set();
    parsed.participants.forEach((participant, index) => {
      const label = 'Участник №' + (index + 1);
      if (!participant || typeof participant !== 'object') {
        errors.push(label + ': запись должна быть объектом.');
        return;
      }
      if (typeof participant.id !== 'string' || !participant.id.trim()) {
        errors.push(label + ': нет строки id.');
      }
      if (typeof participant.checkedIn !== 'boolean') {
        errors.push(label + ': checkedIn должен быть true или false.');
      }
      if (!participant.registeredAt || Number.isNaN(Date.parse(participant.registeredAt))) {
        errors.push(label + ': некорректная дата регистрации.');
      }
      if (participant.archivedAt !== null && Number.isNaN(Date.parse(participant.archivedAt))) {
        errors.push(label + ': archivedAt должен быть null или датой.');
      }
      db.validateParticipant(participant, settings).forEach((error) => {
        errors.push(label + ': ' + error.message);
      });
      const email = db.normalizeEmail(participant.email);
      if (email) {
        if (seenEmails.has(email)) {
          errors.push(label + ': email ' + email + ' повторяется в копии.');
        }
        seenEmails.add(email);
      }
    });

    parsed.activity.forEach((entry, index) => {
      const label = 'Запись журнала №' + (index + 1);
      if (!entry || typeof entry !== 'object' ||
          typeof entry.id !== 'number' || typeof entry.title !== 'string') {
        errors.push(label + ': ожидается объект с числовым id и заголовком title.');
      }
    });

    if (errors.length > 0) {
      throw new Error('Файл содержит некорректные записи и не использован для восстановления. ' +
        errors.slice(0, 5).join(' ') +
        (errors.length > 5 ? ' И ещё ' + (errors.length - 5) + ' ошибок.' : ''));
    }

    return {
      event: parsed.event,
      participants: parsed.participants,
      activity: parsed.activity,
    };
  }

  /** Отрисовка предпросмотра восстановления: что будет заменено. */
  function renderRestorePreview(backup) {
    elements.restoreEventName.textContent = backup.event.name;
    elements.restoreParticipantsCount.textContent = String(backup.participants.length);
    elements.restoreActivityCount.textContent = String(backup.activity.length);
    elements.restoreConfirmCheckbox.checked = false;
    elements.restoreConfirm.disabled = true;
    elements.restorePreview.hidden = false;
  }

  function showRestoreError(message) {
    elements.restoreFileError.textContent = message;
    elements.restoreFileError.hidden = false;
    elements.restorePreview.hidden = true;
    elements.restoreConfirm.disabled = true;
    state.restorePreview = null;
  }

  function hideRestoreError() {
    elements.restoreFileError.textContent = '';
    elements.restoreFileError.hidden = true;
  }

  function resetRestoreDialog() {
    state.restorePreview = null;
    hideRestoreError();
    elements.restoreStatus.textContent = '';
    elements.restoreFile.value = '';
    elements.restorePreview.hidden = true;
    elements.restoreEventName.textContent = '—';
    elements.restoreParticipantsCount.textContent = '0';
    elements.restoreActivityCount.textContent = '0';
    elements.restoreConfirmCheckbox.checked = false;
    elements.restoreConfirm.disabled = true;
  }

  function openRestoreDialog() {
    resetRestoreDialog();
    elements.dialogRestore.showModal();
    elements.restoreFile.focus();
  }

  /**
   * Выбор файла копии: чтение, проверка структуры и версии, предпросмотр.
   * До подтверждения база данных не меняется.
   */
  async function handleRestoreFile() {
    const file = elements.restoreFile.files[0];
    if (!file) {
      return;
    }
    state.restorePreview = null;
    hideRestoreError();
    elements.restorePreview.hidden = true;
    elements.restoreConfirmCheckbox.checked = false;
    elements.restoreConfirm.disabled = true;
    elements.restoreStatus.textContent = 'Проверяем файл…';

    let text;
    try {
      text = await readFileText(file);
    } catch (error) {
      elements.restoreStatus.textContent = '';
      showRestoreError(error.message || 'Не удалось прочитать файл.');
      return;
    }

    try {
      const settings = state.settings || await db.getSettings();
      const parsed = JSON.parse(text);
      const backup = validateBackup(parsed, settings);
      state.restorePreview = { backup, fileName: file.name };
      renderRestorePreview(backup);
    } catch (error) {
      showRestoreError(error instanceof SyntaxError
        ? 'Файл не является корректным JSON.'
        : (error.message || 'Не удалось проверить файл.'));
    } finally {
      elements.restoreStatus.textContent = '';
    }
  }

  /** Подтверждение: полная замена данных одной транзакцией. */
  async function confirmRestore() {
    const preview = state.restorePreview;
    if (!preview || !elements.restoreConfirmCheckbox.checked) {
      return;
    }
    elements.restoreConfirm.disabled = true;
    elements.restoreStatus.textContent = 'Восстанавливаем данные…';
    try {
      const result = await db.restoreBackup(preview.backup, { fileName: preview.fileName });
      elements.dialogRestore.close();
      resetRestoreDialog();
      await refreshData();
      showToast('Копия восстановлена: участников ' + result.participants, 'success', {
        label: 'Отменить',
        onClick: () => undoRestore(result.snapshot),
      });
    } catch (error) {
      elements.restoreStatus.textContent = '';
      showToast(error.message || 'Не удалось восстановить данные', 'error');
      elements.restoreConfirm.disabled = !elements.restoreConfirmCheckbox.checked;
    }
  }

  /** Отмена восстановления: возврат снимка, сделанного перед заменой. */
  async function undoRestore(snapshot) {
    if (!snapshot) {
      return;
    }
    try {
      await db.undoRestoreBackup(snapshot);
      await refreshData();
      showToast('Восстановление копии отменено', 'success');
    } catch (error) {
      showToast(error.message || 'Не удалось отменить восстановление', 'error');
    }
  }

  // ------------------------------------------------------------------
  // Загрузка данных
  // ------------------------------------------------------------------

  async function refreshData() {
    const [participants, activity] = await Promise.all([
      db.getAllParticipants(),
      db.getActivity(20),
    ]);
    state.participants = participants;
    state.activity = activity;
    renderMetrics();
    renderParticipants();
    renderActivity();
  }

  async function init() {
    showState('loading');
    try {
      await db.openDatabase();
      state.settings = await db.getSettings();
      renderHeader();
      renderSelectOptions();
      await refreshData();
    } catch (error) {
      showError(error);
    }
  }

  // ------------------------------------------------------------------
  // Стартовые обработчики
  // ------------------------------------------------------------------

  // Закрытие диалогов по кнопкам «Закрыть»/«Отмена» (Esc работает нативно).
  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = button.closest('dialog');
      if (dialog) {
        dialog.close();
      }
    });
  });

  // Повторная попытка загрузки при ошибке.
  elements.retryButton.addEventListener('click', async () => {
    showState('loading');
    try {
      await db.openDatabase();
      if (!state.settings) {
        state.settings = await db.getSettings();
        renderHeader();
        renderSelectOptions();
      }
      await refreshData();
      showToast('Данные загружены', 'success');
    } catch (error) {
      showError(error);
    }
  });

  // Делегированные действия таблицы, карточки и журнала.
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) {
      return;
    }
    const action = button.dataset.action;
    const id = button.dataset.id || state.currentParticipantId;

    switch (action) {
      case 'add-participant':
        openCreateForm();
        break;
      case 'import-csv':
        openImportDialog();
        break;
      case 'export-json':
        await exportBackup();
        break;
      case 'restore-json':
        openRestoreDialog();
        break;
      case 'undo-restore-backup': {
        const entry = state.activity.find((item) => String(item.id) === button.dataset.id);
        if (entry && entry.meta && entry.meta.snapshot) {
          await undoRestore(entry.meta.snapshot);
        }
        break;
      }
      case 'open-participant':
        if (id) {
          await openDetails(id);
        }
        break;
      case 'edit-participant':
        if (elements.dialogDetails.open) {
          elements.dialogDetails.close();
        }
        if (id) {
          await openEditForm(id);
        }
        break;
      case 'archive-participant':
        if (elements.dialogDetails.open) {
          elements.dialogDetails.close();
        }
        if (id) {
          await archiveWithUndo(id);
        }
        break;
      case 'undo-archive':
        if (id) {
          await undoArchive(id);
        }
        break;
      case 'reset-filters':
        state.view.query = '';
        state.view.status = 'all';
        state.view.ticket = 'all';
        elements.searchInput.value = '';
        elements.filterStatus.value = 'all';
        elements.filterTicket.value = 'all';
        renderParticipants();
        break;
      default:
        // Действия следующих этапов: checkin, export-json, restore-json
        break;
    }
  });

  // Форма участника: отправка и живая проверка.
  elements.participantForm.addEventListener('submit', handleSubmit);

  elements.participantForm.addEventListener('input', (event) => {
    if (event.target.name === 'email') {
      state.emailDuplicate = false; // результат прежней проверки устарел
    }
    refreshFormValidation(false);
  });

  elements.participantForm.addEventListener('focusout', (event) => {
    const field = event.target.name;
    if (!field || !fieldInputs[field]) {
      return;
    }
    state.touched.add(field);
    if (field === 'email') {
      checkEmailUniqueness();
    } else {
      refreshFormValidation(false);
    }
  });

  // Чек-ин в форме доступен только для статуса «Подтверждён».
  fieldInputs.status.addEventListener('change', () => {
    updateCheckedInAvailability();
    refreshFormValidation(false);
  });

  // Поиск, фильтры и сортировка.
  elements.searchInput.addEventListener('input', () => {
    state.view.query = elements.searchInput.value;
    renderParticipants();
  });
  elements.filterStatus.addEventListener('change', () => {
    state.view.status = elements.filterStatus.value;
    renderParticipants();
  });
  elements.filterTicket.addEventListener('change', () => {
    state.view.ticket = elements.filterTicket.value;
    renderParticipants();
  });
  elements.sortSelect.addEventListener('change', () => {
    state.view.sort = elements.sortSelect.value;
    renderParticipants();
  });

  // Импорт CSV: выбор файла, предпросмотр, подтверждение.
  elements.importFile.addEventListener('change', handleImportFile);
  elements.importConfirm.addEventListener('click', confirmImport);
  elements.dialogImport.addEventListener('close', resetImportDialog);

  // Восстановление копии: выбор файла, предпросмотр, подтверждение замены.
  elements.restoreFile.addEventListener('change', handleRestoreFile);
  elements.restoreConfirmCheckbox.addEventListener('change', () => {
    elements.restoreConfirm.disabled =
      !(state.restorePreview && elements.restoreConfirmCheckbox.checked);
  });
  elements.restoreConfirm.addEventListener('click', confirmRestore);
  elements.dialogRestore.addEventListener('close', resetRestoreDialog);

  // Контекст карточки сбрасывается после закрытия диалога.
  elements.dialogDetails.addEventListener('close', () => {
    state.currentParticipantId = null;
  });

  init();
})();
