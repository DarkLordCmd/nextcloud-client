import React, { createContext, useContext, useMemo } from 'react';

const messages = {
  en: {
    language: 'Language',
    'login.subtitle': 'Connect to your cloud storage',
    'login.serverUrl': 'Server URL',
    'login.username': 'Username',
    'login.password': 'Password',
    'login.rememberMe': 'Remember me',
    'login.connecting': 'Connecting…',
    'login.connect': 'Connect',
    'toolbar.upload': 'Upload',
    'toolbar.uploadTitle': 'Upload (Ctrl+U)',
    'toolbar.newFolder': 'New Folder',
    'toolbar.download': 'Download',
    'toolbar.downloadTitle': 'Download',
    'toolbar.delete': 'Delete',
    'toolbar.deleteTitle': 'Delete (Del)',
    'toolbar.refreshTitle': 'Refresh (F5)',
    'toolbar.settingsTitle': 'Settings',
    'toolbar.folderName': 'Folder name:',
    'toolbar.deleteConfirm': 'Delete {count} item(s)?\n\n{names}',
    'toolbar.selected': '{count} selected',
    'folders.title': 'Folders',
    'folders.root': 'Root',
    'filelist.name': 'Name',
    'filelist.size': 'Size',
    'filelist.modified': 'Modified',
    'filelist.loading': 'Loading…',
    'filelist.empty': 'This folder is empty',
    'menu.download': 'Download',
    'menu.preview': 'Preview',
    'menu.rename': 'Rename',
    'menu.delete': 'Delete',
    'menu.refresh': 'Refresh',
    'menu.save': 'Save',
    'menu.deleteConfirm': 'Delete "{name}"?',
    'progress.operation': 'Operation',
    'progress.failed': 'Failed',
    'progress.retry': 'Retry',
    'progress.done': 'Done',
    'settings.title': 'Settings',
    'settings.language': 'Language',
    'settings.uploadLimit': 'Upload speed limit (KB/s, 0 = unlimited)',
    'settings.downloadLimit': 'Download speed limit (KB/s, 0 = unlimited)',
    'settings.downloadDir': 'Default download location',
    'settings.browse': 'Browse…',
    'settings.askSave': 'Ask where to save each download',
    'settings.checking': 'Checking for updates…',
    'settings.upToDate': "You're up to date.",
    'settings.available': 'Update available',
    'settings.downloading': 'Downloading update…',
    'settings.checkError': 'Could not check for updates.',
    'settings.checkUpdates': 'Check for updates',
    'settings.cancel': 'Cancel',
    'settings.save': 'Save',
    'settings.saving': 'Saving…',
    'preview.title': 'Preview',
    'preview.prev': 'Previous (←)',
    'preview.next': 'Next (→)',
    'preview.zoomHint': 'Ctrl+wheel — zoom',
    'preview.download': 'Download',
    'preview.close': 'Close',
    'preview.notFound': 'File not found',
    'preview.loading': 'Loading…',
    'preview.loadError': 'Failed to load: {error}',
    'preview.docUnsupported':
      'Preview of legacy .doc files is not supported. Download the file and open it in Word.',
    'preview.docDownload': 'Download',
    'preview.unavailable': 'Preview is not available for this file type.',
    'preview.footer': '{index} / {total} · wheel to switch, Ctrl+wheel to zoom',
    'preview.emptySheet': 'Empty sheet',
    'app.dropToUpload': 'Drop to upload',
    'breadcrumb.rootTitle': 'Cloud root',
    'errors.not_authenticated': 'Not authenticated. Please log in first.',
    'errors.bad_request': 'Invalid request.',
    'errors.network': 'Network error.',
    'errors.xml': 'Failed to parse server response.',
    'errors.internal': 'Internal server error.',
    'errors.nextcloud_401': 'Invalid credentials or insufficient permissions.',
    'errors.nextcloud_403': 'Access denied by the server.',
    'errors.nextcloud_404': 'File or folder not found.',
    'errors.nextcloud_405': 'Operation not supported by the server.',
    'errors.nextcloud_409': 'Conflict: a file or folder with this name already exists.',
    'errors.nextcloud_412': 'Precondition failed.',
    'errors.nextcloud_423': 'The resource is locked.',
    'errors.nextcloud_507': 'The server is out of storage space.',
  },
  ru: {
    language: 'Язык',
    'login.subtitle': 'Подключитесь к вашему облачному хранилищу',
    'login.serverUrl': 'Адрес сервера',
    'login.username': 'Имя пользователя',
    'login.password': 'Пароль',
    'login.rememberMe': 'Запомнить меня',
    'login.connecting': 'Подключение…',
    'login.connect': 'Войти',
    'toolbar.upload': 'Загрузить',
    'toolbar.uploadTitle': 'Загрузить (Ctrl+U)',
    'toolbar.newFolder': 'Новая папка',
    'toolbar.download': 'Скачать',
    'toolbar.downloadTitle': 'Скачать',
    'toolbar.delete': 'Удалить',
    'toolbar.deleteTitle': 'Удалить (Del)',
    'toolbar.refreshTitle': 'Обновить (F5)',
    'toolbar.settingsTitle': 'Настройки',
    'toolbar.folderName': 'Имя папки:',
    'toolbar.deleteConfirm': 'Удалить {count} элемент(ов)?\n\n{names}',
    'toolbar.selected': 'Выбрано: {count}',
    'folders.title': 'Папки',
    'folders.root': 'Корень',
    'filelist.name': 'Имя',
    'filelist.size': 'Размер',
    'filelist.modified': 'Изменён',
    'filelist.loading': 'Загрузка…',
    'filelist.empty': 'Эта папка пуста',
    'menu.download': 'Скачать',
    'menu.preview': 'Просмотр',
    'menu.rename': 'Переименовать',
    'menu.delete': 'Удалить',
    'menu.refresh': 'Обновить',
    'menu.save': 'Сохранить',
    'menu.deleteConfirm': 'Удалить «{name}»?',
    'progress.operation': 'Операция',
    'progress.failed': 'Ошибка',
    'progress.retry': 'Повторить',
    'progress.done': 'Готово',
    'settings.title': 'Настройки',
    'settings.language': 'Язык',
    'settings.uploadLimit': 'Лимит скорости загрузки (КБ/с, 0 — без ограничения)',
    'settings.downloadLimit': 'Лимит скорости скачивания (КБ/с, 0 — без ограничения)',
    'settings.downloadDir': 'Папка для скачивания по умолчанию',
    'settings.browse': 'Обзор…',
    'settings.askSave': 'Спрашивать, куда сохранять каждый файл',
    'settings.checking': 'Проверка обновлений…',
    'settings.upToDate': 'У вас актуальная версия.',
    'settings.available': 'Доступно обновление',
    'settings.downloading': 'Загрузка обновления…',
    'settings.checkError': 'Не удалось проверить обновления.',
    'settings.checkUpdates': 'Проверить обновления',
    'settings.cancel': 'Отмена',
    'settings.save': 'Сохранить',
    'settings.saving': 'Сохранение…',
    'preview.title': 'Просмотр',
    'preview.prev': 'Предыдущий (←)',
    'preview.next': 'Следующий (→)',
    'preview.zoomHint': 'Ctrl+колесо — масштаб',
    'preview.download': 'Скачать',
    'preview.close': 'Закрыть',
    'preview.notFound': 'Файл не найден',
    'preview.loading': 'Загрузка…',
    'preview.loadError': 'Не удалось загрузить: {error}',
    'preview.docUnsupported':
      'Предпросмотр старых .doc файлов не поддерживается. Скачайте файл и откройте его в Word.',
    'preview.docDownload': 'Скачать',
    'preview.unavailable': 'Предпросмотр для этого типа недоступен.',
    'preview.footer': '{index} / {total} · колесо — переключение, Ctrl+колесо — масштаб',
    'preview.emptySheet': 'Лист пуст',
    'app.dropToUpload': 'Перетащите файлы, чтобы загрузить',
    'breadcrumb.rootTitle': 'Корень облака',
    'errors.not_authenticated': 'Не авторизован. Пожалуйста, войдите.',
    'errors.bad_request': 'Некорректный запрос.',
    'errors.network': 'Сетевая ошибка.',
    'errors.xml': 'Не удалось разобрать ответ сервера.',
    'errors.internal': 'Внутренняя ошибка сервера.',
    'errors.nextcloud_401': 'Неверные учётные данные или недостаточно прав.',
    'errors.nextcloud_403': 'Сервер запретил доступ.',
    'errors.nextcloud_404': 'Файл или папка не найдены.',
    'errors.nextcloud_405': 'Операция не поддерживается сервером.',
    'errors.nextcloud_409': 'Конфликт: файл или папка с таким именем уже существует.',
    'errors.nextcloud_412': 'Не выполнено предусловие.',
    'errors.nextcloud_423': 'Ресурс заблокирован.',
    'errors.nextcloud_507': 'На сервере закончилось место.',
  },
};

const I18nContext = createContext({ language: 'en', t: (k) => k });

export function createTranslator(language) {
  const dict = messages[language] || messages.en;
  return (key, vars) => {
    let s = dict[key] ?? messages.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.split(`{${k}}`).join(v);
      }
    }
    return s;
  };
}

export function I18nProvider({ language, children }) {
  const value = useMemo(() => {
    return { language, t: createTranslator(language) };
  }, [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

// Map an error object ({ code, status, message }) to a translated string.
// Falls back to the raw message when the code is unknown.
export function translateError(t, err) {
  if (!err) return '';
  if (err.code === 'nextcloud' && err.status) {
    const key = `errors.nextcloud_${err.status}`;
    const s = t(key);
    if (s !== key) return s;
    return err.message || t('errors.nextcloud_405');
  }
  if (err.code) {
    const key = `errors.${err.code}`;
    const s = t(key);
    if (s !== key) return s;
  }
  return err.message || '';
}