/* Shared with Angular so first paint and later switches use the same rules. */
(function () {
    'use strict';
    var root = document.documentElement;
    var storageKey = 'avaris_theme';
    var media = window.matchMedia('(prefers-color-scheme: dark)');
    var styles = {};
    var requestId = 0;
    var requestedPreference;

    function read(key) {
        try { return localStorage.getItem(key); } catch (_) { return null; }
    }
    function valid(value) {
        return value === 'light' || value === 'dark' || value === 'system';
    }
    function readPreference() {
        var saved = read(storageKey);
        if (valid(saved)) return saved;
        var legacy = read('cloud_theme');
        return legacy === 'default' ? 'light' : legacy === 'dark' ? 'dark' : 'system';
    }
    function resolve(preference) {
        return preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    }
    function apply(preference, theme) {
        root.dataset.theme = theme;
        root.dataset.themePreference = preference;
        root.style.colorScheme = theme;
        root.classList.remove('default', 'light', 'dark');
        root.classList.add(theme === 'light' ? 'default' : 'dark');
    }
    function stylesheet(theme) {
        if (styles[theme]) return styles[theme];
        styles[theme] = new Promise(function (resolveLoad, rejectLoad) {
            var link = document.createElement('link');
            var timeout;
            link.id = 'avaris-theme-' + theme;
            link.rel = 'stylesheet';
            link.media = 'not all';
            link.href = new URL((theme === 'light' ? 'default' : 'dark') + '.css', document.baseURI).href;
            function fail() {
                clearTimeout(timeout);
                link.remove();
                delete styles[theme];
                rejectLoad(new Error('Unable to load the selected theme.'));
            }
            link.onload = function () { clearTimeout(timeout); resolveLoad(link); };
            link.onerror = fail;
            timeout = setTimeout(fail, 15000);
            document.head.appendChild(link);
        });
        return styles[theme];
    }
    var api = {
        preference: readPreference(),
        resolvedTheme: null,
        ready: null,
        setPreference: function (preference, persist) {
            if (!valid(preference)) return Promise.resolve(false);
            requestedPreference = preference;
            var currentRequest = ++requestId;
            var theme = resolve(preference);
            return stylesheet(theme).then(function () {
                if (currentRequest !== requestId) return false;
                ['light', 'dark'].forEach(function (name) {
                    var existing = document.getElementById('avaris-theme-' + name);
                    if (existing) existing.media = name === theme ? 'all' : 'not all';
                });
                api.preference = preference;
                api.resolvedTheme = theme;
                apply(preference, theme);
                if (persist !== false) {
                    try { localStorage.setItem(storageKey, preference); } catch (_) { /* Storage may be disabled. */ }
                }
                window.dispatchEvent(new CustomEvent('avaris-theme-change'));
                return true;
            }).catch(function () {
                if (currentRequest === requestId) {
                    requestedPreference = api.preference;
                    window.dispatchEvent(new CustomEvent('avaris-theme-error'));
                }
                return false;
            });
        },
    };
    api.resolvedTheme = resolve(api.preference);
    apply(api.preference, api.resolvedTheme);
    window.avarisTheme = api;
    api.ready = api.setPreference(api.preference);
    media.addEventListener('change', function () {
        if (requestedPreference === 'system') api.setPreference('system', false);
    });
    window.addEventListener('storage', function (event) {
        if (event.key === storageKey) api.setPreference(valid(event.newValue) ? event.newValue : 'system', false);
    });
})();
