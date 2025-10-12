# Backend-интерфейс для SPA по курьерским заказам

## 1. Конфигурация и развёртывание
- Добавлены переменные окружения для авторизации и CORS:
  - `SPA_API_KEYS` — список API-ключей через запятую/перевод строки. Если список пустой, backend принимает запросы без ключа (используется для внутренней разработки).  【F:src/config/env.ts†L190-L205】【F:src/config/env.ts†L235-L309】
  - `SPA_ALLOWED_ORIGINS` — список доменов, которым разрешён кросс-доменный доступ. При пустом значении разрешены все origin-ы (совместимость со старым поведением). 【F:src/config/env.ts†L190-L205】
  - `SPA_STREAM_HEARTBEAT_MS` — период heartbeat-сообщений SSE в миллисекундах (по умолчанию 15000). 【F:src/config/env.ts†L190-L205】
- При старте сервера Express регистрирует маршруты SPA и настраивает CORS на основе этих переменных. Попытки обратиться с чужого домена логируются и блокируются. 【F:src/index.ts†L136-L189】
- Все значения замораживаются после загрузки конфигурации, поэтому менять их во время рантайма нельзя. 【F:src/config/env.ts†L318-L338】

## 2. Авторизация и формат ответов
- Все эндпоинты размещены под префиксом `/api/spa`. Каждому запросу нужно добавить заголовок `x-spa-api-key` с одним из ключей из `SPA_API_KEYS`; при отсутствии ключей проверка не выполняется. При ошибке вернётся `401 { "error": "invalid_api_key" }`. 【F:src/http/spaOrders.ts†L52-L158】【F:src/http/spaOrders.ts†L329-L352】
- Ошибки валидации формируют ответ `400 { "error": "validation_error", "details": [...] }`. Для внутренних ошибок — стандартные коды (`500`). 【F:src/http/spaOrders.ts†L204-L249】【F:src/http/spaOrders.ts†L266-L318】
- Схема JSON-ответа содержит объект `order` с сериализованным `OrderRecord`: даты приведены к ISO8601, а исполнителю добавляется вложенный объект `executor` при наличии. 【F:src/http/spaOrders.ts†L223-L258】

## 3. Создание заказа (`POST /api/spa/orders`)
1. Валидируется JSON: тип заказа (`delivery`/`taxi`), город (доступные города берутся из доменного списка), контактные данные клиента и получателя, адреса с координатами, флаги частного дома, комментарий. При отсутствии цены backend сам считает тариф (из `estimateDeliveryPrice`/`estimateTaxiPrice`). 【F:src/http/spaOrders.ts†L160-L222】
2. После успешной валидации вызывается `createOrder`, записывающий заказ со статусом `new` в Postgres. 【F:src/http/spaOrders.ts†L204-L220】【F:src/db/orders.ts†L211-L287】
3. Заказ публикуется в канал исполнителей через `publishOrderToDriversChannel`. Возвращается статус `published`, `already_published` или `missing_channel`. При любой ошибке публикации заказ автоматически помечается `cancelled`, а клиенту возвращается `publish_failed`. 【F:src/http/spaOrders.ts†L233-L264】【F:src/bot/channels/ordersChannel.ts†L642-L714】
4. В ответе `201` клиент получает текущий снимок заказа (вместе с ID сообщения в канале, если публикация прошла) и итоговый статус публикации. 【F:src/http/spaOrders.ts†L258-L264】

## 4. Получение и отмена заказа
- `GET /api/spa/orders/:id` — отдаёт текущий снимок заказа или `404`, если заказ не найден. 【F:src/http/spaOrders.ts†L266-L284】
- `POST /api/spa/orders/:id/cancel` — переводит заказ в `cancelled`, даже если он уже взят исполнителем. После успешной отмены backend удаляет сообщение из канала и уведомляет исполнителя, используя штатный bridge бота. Повторная отмена для уже завершённых/отменённых заказов возвращает `updated: false`. 【F:src/http/spaOrders.ts†L286-L327】【F:src/bot/channels/ordersChannel.ts†L409-L452】

## 5. Live-стрим статусов (`GET /api/spa/orders/:id/stream`)
- Перед установлением SSE-подключения backend проверяет наличие заказа (иначе вернётся `404`). При успехе сразу отправляется событие `snapshot` с текущими данными. 【F:src/http/spaOrders.ts†L329-L369】
- Далее backend подписывается на `OrderEventEmitter` и на каждое событие отправляет клиенту объект `{ type, order }`, где `type` — `created/updated/cancelled/expired/completed`. Между событиями шлются heartbeat-комментарии (`: heartbeat`) с интервалом `SPA_STREAM_HEARTBEAT_MS`. 【F:src/http/spaOrders.ts†L371-L412】【F:src/services/orderEvents.ts†L5-L69】
- При разрыве соединения heartbeat очищается, подписка отписывается. Клиенту достаточно переоткрыть поток, чтобы продолжить получать обновления. 【F:src/http/spaOrders.ts†L401-L412】

## 6. События и синхронизация с Telegram-ботом
- Модуль `orderEvents` реализует единый `EventEmitter` для заказов и маппинг статусов → типов событий. 【F:src/services/orderEvents.ts†L1-L69】
- Все основные операции с заказами (`create`, `markOrderAsOpen`, `tryClaimOrder`, `markOrderAsCancelled`, `expireStaleOrders`, `cancelClientOrder`, `setOrderChannelMessageId` и т.д.) теперь вызывают `notifyOrderCreated/notifyOrderUpdated`, поэтому SPA получает live-уведомления не только о своих действиях, но и о действиях исполнителей из Telegram. 【F:src/db/orders.ts†L168-L615】
- Когда заказ публикуется в канал, backend синхронизирует `channelMessageId`, а при отмене из SPA мост бота чистит сообщение в канале и уведомляет исполнителя, сохраняя привычное поведение Telegram-бота. 【F:src/bot/channels/ordersChannel.ts†L642-L714】【F:src/http/spaOrders.ts†L294-L327】

## 7. Рекомендации для SPA-клиента
- **Повторная авторизация:** при получении `401` обновите API-ключ (например, через secure storage) и повторите запрос.
- **Устойчивость UI:** используйте SSE-поток для живых обновлений и fallback-опрашивание `GET /orders/:id`, если соединение рвётся.
- **Обработка статусов публикации:** `publish_failed` означает, что заказ сохранён, но не попал в канал; нужно показать пользователю сообщение об ошибке и передать заказ в ручную обработку.
- **Согласованность с ботом:** любые дополнительные изменения статусов нужно проводить через backend, чтобы не ломать бизнес-метрики (`activeOrdersGauge`) и push-уведомления. 【F:src/db/orders.ts†L180-L611】
