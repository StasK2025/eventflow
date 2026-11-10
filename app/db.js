'use strict';

/**
 * EventFlow — слой работы с IndexedDB.
 *
 * База: eventflow-db, версия 1.
 * Хранилища:
 *   participants — участники, ключ id (UUID, автоинкремент не используется);
 *     индексы: email (unique), status, registeredAt, archivedAt;
 *   settings — настройки события, ключ key;
 *   activity — журнал действий, ключ id (автоинкремент).
 *
 * Правила:
 *   - операции, меняющие несколько записей, выполняются одной транзакцией;
 *   - email хранится в нижнем регистре — уникальность без учёта регистра
 *     обеспечивается нормализацией и уникальным индексом;
 *   - checkedIn: true допустим только для статуса confirmed.
 */

window.EventFlowDB = (() => {
  const DB_NAME = 'eventflow-db';
  const DB_VERSION = 1;

  const STORE_PARTICIPANTS = 'participants';
  const STORE_SETTINGS = 'settings';
  const STORE_ACTIVITY = 'activity';

  // Начальные значения соответствуют data/event-settings.json.
  const DEFAULT_EVENT = {
    name: 'Практикум «Продукты с ИИ»',
    venue: 'Учебный центр',
    capacity: 120,
  };
  const DEFAULT_STATUSES = [
    { value: 'new', label: 'Новый' },
    { value: 'confirmed', label: 'Подтверждён' },
    { value: 'waitlist', label: 'Лист ожидания' },
    { value: 'cancelled', label: 'Отменён' },
  ];
  const DEFAULT_TICKETS = [
    { value: 'standard', label: 'Стандартный' },
    { value: 'business', label: 'Бизнес' },
    { value: 'vip', label: 'VIP' },
  ];
  const DEFAULT_SETTINGS = [
    { key: 'event', value: DEFAULT_EVENT },
    { key: 'statuses', value: DEFAULT_STATUSES },
    { key: 'tickets', value: DEFAULT_TICKETS },
  ];

  /** Ошибка проверки данных: содержит список ошибок по полям. */
  class ValidationError extends Error {
    constructor(errors) {
      super(errors.map((error) => error.message).join(' '));
      this.name = 'ValidationError';
      this.errors = errors;
    }
  }

  // Кэш открытого соединения. Сбрасывается при неудаче, чтобы «Повторить»
  // могло открыть базу заново.
  let dbPromise = null;

  // ------------------------------------------------------------------
  // Вспомогательные функции
  // ------------------------------------------------------------------

  /** UUID для id участника. */
  function createId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Запасной вариант для старых браузеров
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const random = (Math.random() * 16) | 0;
      const value = char === 'x' ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    });
  }

  /** Приведение email к единому виду: trim + нижний регистр. */
  function normalizeEmail(email) {
    return String(email === undefined || email === null ? '' : email).trim().toLowerCase();
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  }

  /** Обёртка над IDBRequest в Promise. */
  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Ошибка запроса к базе данных'));
    });
  }

  /**
   * Транзакция с промисным результатом.
   * Работа внутри транзакции — асинхронная функция; если она бросает ошибку,
   * транзакция откатывается целиком.
   */
  function withTransaction(storeNames, mode, work) {
    return openDatabase().then((db) => new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(storeNames, mode);
      } catch (error) {
        reject(error);
        return;
      }
      let workResult;
      let workFailed = false;
      tx.oncomplete = () => resolve(workResult);
      tx.onerror = () => {
        if (!workFailed) {
          reject(tx.error || new Error('Транзакция завершилась с ошибкой'));
        }
      };
      tx.onabort = () => {
        if (!workFailed) {
          reject(tx.error || new Error('Транзакция была прервана'));
        }
      };
      Promise.resolve()
        .then(() => work(tx))
        .then((value) => {
          workResult = value;
        })
        .catch((error) => {
          workFailed = true;
          try {
            tx.abort();
          } catch (ignore) {
            // транзакция уже завершена — откатывать нечего
          }
          reject(error);
        });
    }));
  }

  /** Запись события в журнал внутри открытой транзакции. */
  function logActivity(tx, entry) {
    const record = Object.assign(
      {
        at: new Date().toISOString(),
        type: 'info',
        title: 'Действие',
        details: '',
        meta: null,
      },
      entry
    );
    return requestToPromise(tx.objectStore(STORE_ACTIVITY).add(record));
  }

  // ------------------------------------------------------------------
  // Схема и миграции
  // ------------------------------------------------------------------

  /**
   * Создание хранилищ и индексов. Проверки через contains() позволяют
   * вызывать helper и в будущих версиях схемы: уже существующие объекты
   * не пересоздаются, а только дополняются.
   */
  function upgradeSchema(db, versionChangeTransaction) {
    let participants;
    if (!db.objectStoreNames.contains(STORE_PARTICIPANTS)) {
      // Автоинкремент не используется: id — UUID, создаётся приложением.
      participants = db.createObjectStore(STORE_PARTICIPANTS, { keyPath: 'id' });
    } else {
      participants = versionChangeTransaction.objectStore(STORE_PARTICIPANTS);
    }
    if (!participants.indexNames.contains('email')) {
      participants.createIndex('email', 'email', { unique: true });
    }
    if (!participants.indexNames.contains('status')) {
      participants.createIndex('status', 'status', { unique: false });
    }
    if (!participants.indexNames.contains('registeredAt')) {
      participants.createIndex('registeredAt', 'registeredAt', { unique: false });
    }
    if (!participants.indexNames.contains('archivedAt')) {
      participants.createIndex('archivedAt', 'archivedAt', { unique: false });
    }

    if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
      db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
    }

    if (!db.objectStoreNames.contains(STORE_ACTIVITY)) {
      db.createObjectStore(STORE_ACTIVITY, { keyPath: 'id', autoIncrement: true });
    }
  }

  /**
   * Идемпотентный сид настроек: добавляются только отсутствующие ключи,
   * существующие значения (например, изменённое название события) не трогаются.
   */
  function ensureSeed(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readwrite');
      const store = tx.objectStore(STORE_SETTINGS);
      const getAllRequest = store.getAll();
      getAllRequest.onsuccess = () => {
        const existingKeys = new Set(getAllRequest.result.map((record) => record.key));
        DEFAULT_SETTINGS.forEach((record) => {
          if (!existingKeys.has(record.key)) {
            store.put(record);
          }
        });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Не удалось подготовить настройки события'));
      tx.onabort = () => reject(tx.error || new Error('Не удалось подготовить настройки события'));
    });
  }

  /** Открытие базы (один раз на сессию) + сид настроек. */
  function openDatabase() {
    if (dbPromise) {
      return dbPromise;
    }
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('Браузер не поддерживает IndexedDB. Включите хранение данных сайта и повторите попытку.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        // Транзакция обновления схемы включает все создаваемые хранилища.
        upgradeSchema(request.result, request.transaction);
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        ensureSeed(db)
          .then(() => resolve(db))
          .catch((error) => reject(error));
      };

      request.onerror = () => {
        reject(new Error('Не удалось открыть базу данных eventflow-db: ' +
          (request.error && request.error.message ? request.error.message : 'ошибка IndexedDB')));
      };

      request.onblocked = () => {
        reject(new Error('Открытие базы заблокировано другой вкладкой. Закройте другие вкладки приложения и повторите попытку.'));
      };
    });

    // При неудаче сбрасываем кэш, чтобы повторная попытка имела смысл.
    dbPromise.catch(() => {
      dbPromise = null;
    });

    return dbPromise;
  }

  // ------------------------------------------------------------------
  // Проверка данных
  // ------------------------------------------------------------------

  /**
   * Проверка модели участника. Возвращает массив { field, message };
   * пустой массив означает, что данные корректны.
   * Уникальность email проверяется отдельно — она требует чтения базы.
   */
  function validateParticipant(data, settings) {
    const errors = [];
    const statuses = (settings && settings.statuses) || DEFAULT_STATUSES;
    const tickets = (settings && settings.tickets) || DEFAULT_TICKETS;

    const name = String(data.name === undefined || data.name === null ? '' : data.name).trim();
    if (!name) {
      errors.push({ field: 'name', message: 'Укажите имя участника.' });
    }

    const email = normalizeEmail(data.email);
    if (!email) {
      errors.push({ field: 'email', message: 'Укажите email участника.' });
    } else if (!isValidEmail(email)) {
      errors.push({ field: 'email', message: 'Email должен содержать @ и домен, например user@mail.ru.' });
    }

    const ticketValues = tickets.map((ticket) => ticket.value);
    if (ticketValues.indexOf(data.ticket) === -1) {
      errors.push({
        field: 'ticket',
        message: 'Выберите тип билета из списка: ' + tickets.map((ticket) => ticket.label).join(', ') + '.',
      });
    }

    const statusValues = statuses.map((status) => status.value);
    const checkedIn = data.checkedIn === true;
    if (statusValues.indexOf(data.status) === -1) {
      errors.push({
        field: 'status',
        message: 'Выберите статус из списка: ' + statuses.map((status) => status.label).join(', ') + '.',
      });
    } else if (checkedIn && data.status !== 'confirmed') {
      const confirmedStatus = statuses.find((status) => status.value === 'confirmed');
      const confirmedLabel = confirmedStatus ? confirmedStatus.label : 'Подтверждён';
      errors.push({
        field: 'checkedIn',
        message: 'Чек-ин возможен только для статуса «' + confirmedLabel +
          '». Снимите отметку о прибытии или измените статус.',
      });
    }

    if (data.registeredAt !== undefined && data.registeredAt !== null && data.registeredAt !== '') {
      if (Number.isNaN(Date.parse(data.registeredAt))) {
        errors.push({
          field: 'registeredAt',
          message: 'Некорректная дата регистрации. Ожидается формат ISO, например 2026-08-18T09:20:00Z.',
        });
      }
    }

    return errors;
  }

  // ------------------------------------------------------------------
  // Чтение
  // ------------------------------------------------------------------

  /** Настройки события: { event, statuses, tickets }. */
  function getSettings() {
    return withTransaction(STORE_SETTINGS, 'readonly', (tx) =>
      requestToPromise(tx.objectStore(STORE_SETTINGS).getAll())
    ).then((records) => {
      const map = {};
      records.forEach((record) => {
        map[record.key] = record.value;
      });
      return {
        event: map.event || DEFAULT_EVENT,
        statuses: map.statuses || DEFAULT_STATUSES,
        tickets: map.tickets || DEFAULT_TICKETS,
      };
    });
  }

  /** Все участники, включая архивные. */
  function getAllParticipants() {
    return withTransaction(STORE_PARTICIPANTS, 'readonly', (tx) =>
      requestToPromise(tx.objectStore(STORE_PARTICIPANTS).getAll())
    );
  }

  /** Только активные участники (не в архиве). */
  function getActiveParticipants() {
    return getAllParticipants().then((participants) =>
      participants.filter((participant) => !participant.archivedAt)
    );
  }

  /** Участник по id или null. */
  function getParticipantById(id) {
    return withTransaction(STORE_PARTICIPANTS, 'readonly', (tx) =>
      requestToPromise(tx.objectStore(STORE_PARTICIPANTS).get(id))
    ).then((participant) => participant || null);
  }

  /** Участник по email (без учёта регистра) или null. */
  function getParticipantByEmail(email) {
    const normalized = normalizeEmail(email);
    return withTransaction(STORE_PARTICIPANTS, 'readonly', (tx) =>
      requestToPromise(tx.objectStore(STORE_PARTICIPANTS).index('email').get(normalized))
    ).then((participant) => participant || null);
  }

  /** Журнал действий, новые записи первыми; limit — необязательное ограничение. */
  function getActivity(limit) {
    return withTransaction(STORE_ACTIVITY, 'readonly', (tx) =>
      requestToPromise(tx.objectStore(STORE_ACTIVITY).getAll())
    ).then((entries) => {
      const sorted = entries.slice().sort((a, b) => {
        const byTime = String(b.at).localeCompare(String(a.at));
        return byTime !== 0 ? byTime : b.id - a.id;
      });
      return typeof limit === 'number' && limit > 0 ? sorted.slice(0, limit) : sorted;
    });
  }

  // ------------------------------------------------------------------
  // Запись: участники
  // ------------------------------------------------------------------

  /**
   * Добавление участника. Одна транзакция: проверка уникальности email,
   * запись участника и запись в журнал.
   */
  function addParticipant(input) {
    return getSettings().then((settings) => {
      const errors = validateParticipant(input, settings);
      if (errors.length > 0) {
        throw new ValidationError(errors);
      }
      const participant = {
        id: input.id || createId(),
        name: String(input.name).trim(),
        email: normalizeEmail(input.email),
        company: String(input.company === undefined || input.company === null ? '' : input.company).trim(),
        ticket: input.ticket,
        status: input.status,
        checkedIn: input.checkedIn === true,
        registeredAt: input.registeredAt || new Date().toISOString(),
        archivedAt: null,
      };

      return withTransaction([STORE_PARTICIPANTS, STORE_ACTIVITY], 'readwrite', async (tx) => {
        const store = tx.objectStore(STORE_PARTICIPANTS);
        const existing = await requestToPromise(store.index('email').get(participant.email));
        if (existing) {
          throw new Error('Email ' + participant.email + ' уже используется другим участником. Откройте его запись, чтобы изменить.');
        }
        await requestToPromise(store.add(participant));
        await logActivity(tx, {
          type: 'create',
          title: 'Добавлен участник',
          details: participant.name,
          meta: { participantId: participant.id },
        });
        return participant;
      });
    });
  }

  /**
   * Редактирование участника. Одна транзакция: чтение, проверка email,
   * сохранение и запись в журнал.
   */
  function updateParticipant(id, patch) {
    return getSettings().then((settings) =>
      withTransaction([STORE_PARTICIPANTS, STORE_ACTIVITY], 'readwrite', async (tx) => {
        const store = tx.objectStore(STORE_PARTICIPANTS);
        const current = await requestToPromise(store.get(id));
        if (!current) {
          throw new Error('Участник не найден. Возможно, запись была удалена в другой вкладке.');
        }
        const next = {
          id: current.id,
          name: patch.name !== undefined ? String(patch.name).trim() : current.name,
          email: patch.email !== undefined ? normalizeEmail(patch.email) : current.email,
          company: patch.company !== undefined ? String(patch.company).trim() : current.company,
          ticket: patch.ticket !== undefined ? patch.ticket : current.ticket,
          status: patch.status !== undefined ? patch.status : current.status,
          checkedIn: patch.checkedIn !== undefined ? patch.checkedIn === true : current.checkedIn,
          registeredAt: patch.registeredAt !== undefined ? patch.registeredAt : current.registeredAt,
          archivedAt: current.archivedAt,
        };
        const errors = validateParticipant(next, settings);
        if (errors.length > 0) {
          throw new ValidationError(errors);
        }
        if (next.email !== current.email) {
          const clash = await requestToPromise(store.index('email').get(next.email));
          if (clash && clash.id !== id) {
            throw new Error('Email ' + next.email + ' уже используется другим участником.');
          }
        }
        await requestToPromise(store.put(next));
        await logActivity(tx, {
          type: 'update',
          title: 'Изменён участник',
          details: next.name,
          meta: { participantId: next.id },
        });
        return next;
      })
    );
  }

  /** Отметка о прибытии. Допустима только для статуса confirmed. */
  function setCheckedIn(id, checkedIn) {
    const value = checkedIn === true;
    return withTransaction([STORE_PARTICIPANTS, STORE_ACTIVITY], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_PARTICIPANTS);
      const current = await requestToPromise(store.get(id));
      if (!current) {
        throw new Error('Участник не найден.');
      }
      if (value && current.status !== 'confirmed') {
        throw new Error('Чек-ин возможен только для статуса «Подтверждён». Сначала измените статус участника.');
      }
      const next = Object.assign({}, current, { checkedIn: value });
      await requestToPromise(store.put(next));
      await logActivity(tx, {
        type: value ? 'checkin' : 'checkout',
        title: value ? 'Отмечен приход участника' : 'Снята отметка о приходе',
        details: current.name,
        meta: { participantId: id },
      });
      return next;
    });
  }

  /** Архивация вместо удаления. Запись остаётся в базе. */
  function archiveParticipant(id) {
    return withTransaction([STORE_PARTICIPANTS, STORE_ACTIVITY], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_PARTICIPANTS);
      const current = await requestToPromise(store.get(id));
      if (!current) {
        throw new Error('Участник не найден.');
      }
      if (current.archivedAt) {
        return current; // уже в архиве
      }
      const next = Object.assign({}, current, { archivedAt: new Date().toISOString() });
      await requestToPromise(store.put(next));
      await logActivity(tx, {
        type: 'archive',
        title: 'Участник заархивирован',
        details: current.name,
        // previousArchivedAt нужен для кнопки «Отменить» в уведомлении
        meta: { participantId: id, previousArchivedAt: current.archivedAt },
      });
      return next;
    });
  }

  /** Возврат участника из архива (отмена архивации). */
  function restoreParticipant(id) {
    return withTransaction([STORE_PARTICIPANTS, STORE_ACTIVITY], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_PARTICIPANTS);
      const current = await requestToPromise(store.get(id));
      if (!current) {
        throw new Error('Участник не найден.');
      }
      const next = Object.assign({}, current, { archivedAt: null });
      await requestToPromise(store.put(next));
      await logActivity(tx, {
        type: 'restore',
        title: 'Участник восстановлен из архива',
        details: current.name,
        meta: { participantId: id },
      });
      return next;
    });
  }

  /**
   * Импорт подготовленных строк (например, из CSV) одной транзакцией.
   * Строка с email, который уже есть в базе, обновляет существующую запись
   * (id сохраняется), новые строки добавляются с UUID — дубликаты по email
   * не создаются. Итог записывается в журнал одной транзакцией.
   * meta: { fileName, skipped } — сведения для записи журнала.
   * Возвращает { added, updated }.
   */
  function importParticipants(drafts, meta) {
    return getSettings().then((settings) => {
      drafts.forEach((draft) => {
        const errors = validateParticipant(draft, settings);
        if (errors.length > 0) {
          throw new ValidationError(errors);
        }
      });

      return withTransaction([STORE_PARTICIPANTS, STORE_ACTIVITY], 'readwrite', async (tx) => {
        const store = tx.objectStore(STORE_PARTICIPANTS);
        let added = 0;
        let updated = 0;

        for (const draft of drafts) {
          const email = normalizeEmail(draft.email);
          const record = {
            name: String(draft.name).trim(),
            email,
            company: String(draft.company === undefined || draft.company === null ? '' : draft.company).trim(),
            ticket: draft.ticket,
            status: draft.status,
            checkedIn: draft.checkedIn === true,
            registeredAt: new Date(draft.registeredAt).toISOString(),
          };
          const existing = await requestToPromise(store.index('email').get(email));
          if (existing) {
            // Обновление: id и состояние архива сохраняются
            await requestToPromise(store.put(Object.assign({}, record, {
              id: existing.id,
              archivedAt: existing.archivedAt,
            })));
            updated += 1;
          } else {
            await requestToPromise(store.add(Object.assign({}, record, {
              id: createId(),
              archivedAt: null,
            })));
            added += 1;
          }
        }

        const skipped = (meta && meta.skipped) || 0;
        await logActivity(tx, {
          type: 'import',
          title: 'Импорт CSV',
          details: 'Добавлено: ' + added + ', обновлено: ' + updated + ', пропущено: ' + skipped,
          meta: {
            fileName: (meta && meta.fileName) || '',
            added,
            updated,
            skipped,
          },
        });
        return { added, updated };
      });
    });
  }

  // ------------------------------------------------------------------
  // Резервные копии (JSON)
  // ------------------------------------------------------------------

  /**
   * Снимок снапшотов: в выгрузку (экспорт и откат восстановления) не попадают
   * вложенные снимки прошлых восстановлений — иначе файлы росли бы бесконечно.
   */
  function stripSnapshots(data) {
    return {
      event: data.event,
      participants: data.participants,
      activity: data.activity.map((entry) => {
        if (!entry.meta || !entry.meta.snapshot) {
          return entry;
        }
        const meta = Object.assign({}, entry.meta);
        delete meta.snapshot;
        return Object.assign({}, entry, { meta });
      }),
    };
  }

  /** Полные данные внутри открытой транзакции. */
  async function readAllData(tx) {
    const participants = await requestToPromise(tx.objectStore(STORE_PARTICIPANTS).getAll());
    const eventRecord = await requestToPromise(tx.objectStore(STORE_SETTINGS).get('event'));
    const activity = await requestToPromise(tx.objectStore(STORE_ACTIVITY).getAll());
    return stripSnapshots({
      event: eventRecord ? eventRecord.value : DEFAULT_EVENT,
      participants,
      activity,
    });
  }

  /** Данные для резервной копии: настройки события, участники и журнал. */
  function getBackup() {
    return withTransaction([STORE_PARTICIPANTS, STORE_SETTINGS, STORE_ACTIVITY], 'readonly', (tx) =>
      readAllData(tx)
    );
  }

  /** Одна запись в журнале действий (например, об экспорте копии). */
  function addActivity(entry) {
    return withTransaction(STORE_ACTIVITY, 'readwrite', (tx) => logActivity(tx, entry));
  }

  /** Полная замена данных одной транзакцией: участники, журнал, настройки. */
  async function replaceAllData(tx, data) {
    const participantsStore = tx.objectStore(STORE_PARTICIPANTS);
    const settingsStore = tx.objectStore(STORE_SETTINGS);
    const activityStore = tx.objectStore(STORE_ACTIVITY);

    await requestToPromise(participantsStore.clear());
    await requestToPromise(activityStore.clear());

    for (const participant of data.participants) {
      await requestToPromise(participantsStore.put(participant));
    }
    for (const entry of data.activity) {
      await requestToPromise(activityStore.put(entry));
    }
    if (data.event) {
      await requestToPromise(settingsStore.put({ key: 'event', value: data.event }));
    }
  }

  /**
   * Восстановление резервной копии одной транзакцией: участники и журнал
   * заменяются полностью, настройки события обновляются. Перед заменой
   * сохраняется снимок текущих данных — он вкладывается в запись журнала
   * и позволяет отменить восстановление.
   */
  function restoreBackup(backup, meta) {
    return withTransaction([STORE_PARTICIPANTS, STORE_SETTINGS, STORE_ACTIVITY], 'readwrite', async (tx) => {
      const snapshot = await readAllData(tx);
      await replaceAllData(tx, backup);
      await logActivity(tx, {
        type: 'restore-backup',
        title: 'Восстановлена резервная копия',
        details: 'Участников: ' + backup.participants.length + ', записей журнала: ' + backup.activity.length,
        meta: {
          fileName: (meta && meta.fileName) || '',
          snapshot,
        },
      });
      return {
        participants: backup.participants.length,
        activity: backup.activity.length,
        snapshot,
      };
    });
  }

  /** Отмена восстановления: возврат снимка, сделанного перед заменой. */
  function undoRestoreBackup(snapshot) {
    return withTransaction([STORE_PARTICIPANTS, STORE_SETTINGS, STORE_ACTIVITY], 'readwrite', async (tx) => {
      await replaceAllData(tx, snapshot);
      await logActivity(tx, {
        type: 'undo-restore',
        title: 'Восстановление копии отменено',
        details: 'Возвращены данные, сохранённые до замены',
        meta: null,
      });
      return {
        participants: snapshot.participants.length,
        activity: snapshot.activity.length,
      };
    });
  }

  // ------------------------------------------------------------------
  // Публичный интерфейс
  // ------------------------------------------------------------------

  return {
    DB_NAME,
    DB_VERSION,
    ValidationError,
    openDatabase,
    normalizeEmail,
    validateParticipant,
    getSettings,
    getAllParticipants,
    getActiveParticipants,
    getParticipantById,
    getParticipantByEmail,
    getActivity,
    addParticipant,
    updateParticipant,
    setCheckedIn,
    archiveParticipant,
    restoreParticipant,
    importParticipants,
    getBackup,
    addActivity,
    restoreBackup,
    undoRestoreBackup,
  };
})();
