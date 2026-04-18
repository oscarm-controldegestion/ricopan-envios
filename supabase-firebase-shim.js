// ============================================================
// SUPABASE → FIREBASE SHIM
// Provee API compatible con firebase.database() usando Supabase
// ============================================================
// Uso: incluir ANTES del código de la app
//   window.SUPABASE_URL = 'https://...supabase.co';
//   window.SUPABASE_KEY = 'eyJ...';
// ============================================================

(function() {

  // Cache en memoria: { namespace: { key: value } }
  const _cache = {};
  const _cacheLoaded = {};
  let _client = null;

  function getClient() {
    if (!_client) {
      _client = supabase.createClient(
        window.SUPABASE_URL,
        window.SUPABASE_KEY
      );
    }
    return _client;
  }

  // Establece un valor anidado en un objeto
  function setNested(obj, parts, value) {
    if (!parts.length) return;
    if (parts.length === 1) {
      if (value === null || value === undefined) delete obj[parts[0]];
      else obj[parts[0]] = value;
      return;
    }
    if (!obj[parts[0]] || typeof obj[parts[0]] !== 'object') obj[parts[0]] = {};
    setNested(obj[parts[0]], parts.slice(1), value);
  }

  // Obtiene un valor anidado de un objeto
  function getNested(obj, parts) {
    if (!parts.length) return obj;
    if (!obj || typeof obj !== 'object') return null;
    const val = obj[parts[0]];
    return val !== undefined ? getNested(val, parts.slice(1)) : null;
  }

  // Carga todos los datos de un namespace desde Supabase
  async function loadNamespace(namespace) {
    if (_cacheLoaded[namespace]) return;
    const { data } = await getClient()
      .from('kv_store')
      .select('key, value')
      .eq('namespace', namespace);

    if (!_cache[namespace]) _cache[namespace] = {};
    for (const row of (data || [])) {
      _cache[namespace][row.key] = row.value;
    }
    _cacheLoaded[namespace] = true;
  }

  // Guarda un key-value en Supabase
  async function saveKV(namespace, key, value) {
    if (value === null || value === undefined) {
      await getClient().from('kv_store')
        .delete()
        .eq('namespace', namespace)
        .eq('key', key);
      if (_cache[namespace]) delete _cache[namespace][key];
    } else {
      await getClient().from('kv_store')
        .upsert({ namespace, key, value, ts: Date.now() });
      if (!_cache[namespace]) _cache[namespace] = {};
      _cache[namespace][key] = value;
    }
  }

  // DataSnapshot shim
  class DataSnapshot {
    constructor(val, keyName) {
      this._val = val;
      this._key = keyName || null;
    }
    val() { return this._val !== undefined ? this._val : null; }
    exists() {
      const v = this.val();
      return v !== null && v !== undefined;
    }
    forEach(cb) {
      const v = this.val();
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, childVal] of Object.entries(v)) {
          if (cb(new DataSnapshot(childVal, k)) === true) break;
        }
      }
    }
    get key() { return this._key; }
  }

  // DatabaseReference shim
  class Ref {
    constructor(path) {
      this._path = (path || '').replace(/^\/+|\/+$/g, '');
    }

    _parse() {
      const parts = this._path.split('/').filter(Boolean);
      return {
        parts,
        ns: parts[0] || null,    // namespace = first segment
        key: parts[1] || null,   // kv_store key = second segment
        sub: parts.slice(2)      // nested path within the value
      };
    }

    ref(path) {
      const full = path
        ? (this._path ? this._path + '/' + path.replace(/^\//, '') : path)
        : this._path;
      return new Ref(full);
    }

    async get() { return this.once('value'); }

    async once(event) {
      const { ns, key, sub } = this._parse();
      if (!ns) return new DataSnapshot({});

      await loadNamespace(ns);
      const nsData = _cache[ns] || {};

      if (!key) {
        // Devuelve todo el namespace
        return new DataSnapshot({ ...nsData });
      }

      const keyData = nsData[key] !== undefined ? nsData[key] : null;
      if (!sub.length) return new DataSnapshot(keyData, key);
      return new DataSnapshot(getNested(keyData, sub), sub[sub.length - 1]);
    }

    on(event, callback, errCallback) {
      if (event === 'value') {
        this.get()
          .then(snap => callback(snap))
          .catch(e => errCallback ? errCallback(e) : console.warn('Ref.on error:', e));
      }
      return callback;
    }

    off() {}

    async set(value) {
      const { ns, key, sub } = this._parse();
      if (!ns || !key) return;
      await loadNamespace(ns);
      if (!_cache[ns]) _cache[ns] = {};

      if (!sub.length) {
        _cache[ns][key] = value;
        await saveKV(ns, key, value);
      } else {
        if (!_cache[ns][key] || typeof _cache[ns][key] !== 'object') _cache[ns][key] = {};
        setNested(_cache[ns][key], sub, value);
        await saveKV(ns, key, _cache[ns][key]);
      }
    }

    async update(updates) {
      const toSave = {}; // "ns::key" → {ns, key}

      for (const [path, value] of Object.entries(updates)) {
        const parts = path.replace(/^\/+/, '').split('/').filter(Boolean);
        const ns = parts[0];
        const key = parts[1];
        const sub = parts.slice(2);
        if (!ns || !key) continue;

        await loadNamespace(ns);
        if (!_cache[ns]) _cache[ns] = {};

        if (!sub.length) {
          if (value === null) delete _cache[ns][key];
          else _cache[ns][key] = value;
        } else {
          if (!_cache[ns][key] || typeof _cache[ns][key] !== 'object') _cache[ns][key] = {};
          setNested(_cache[ns][key], sub, value);
        }
        toSave[`${ns}::${key}`] = { ns, key };
      }

      for (const { ns, key } of Object.values(toSave)) {
        await saveKV(ns, key, (_cache[ns] || {})[key] ?? null);
      }
    }

    async push(value) {
      const { ns, key, sub } = this._parse();
      if (!ns || !key) return this;
      await loadNamespace(ns);
      if (!_cache[ns]) _cache[ns] = {};

      const id = '-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);

      if (!sub.length) {
        if (!_cache[ns][key] || typeof _cache[ns][key] !== 'object') _cache[ns][key] = {};
        _cache[ns][key][id] = value;
        await saveKV(ns, key, _cache[ns][key]);
      } else {
        const parent = getNested(_cache[ns][key], sub) || {};
        parent[id] = value;
        setNested(_cache[ns][key], sub, parent);
        await saveKV(ns, key, _cache[ns][key]);
      }

      const newRef = new Ref(this._path + '/' + id);
      newRef._pushedKey = id;
      return newRef;
    }

    async remove() {
      const { ns, key, sub } = this._parse();
      if (!ns || !key) return;
      await loadNamespace(ns);

      if (!sub.length) {
        delete (_cache[ns] || {})[key];
        await saveKV(ns, key, null);
      } else {
        if (_cache[ns] && _cache[ns][key]) {
          setNested(_cache[ns][key], sub, null);
          await saveKV(ns, key, _cache[ns][key]);
        }
      }
    }
  }

  // DB factory (supports both `firebase.database()` and direct `DB = firebase.database()`)
  function makeDB() {
    return {
      ref(path) { return new Ref(path || ''); }
    };
  }

  // Expone firebase namespace global (compatible con firebase-compat SDK)
  window.firebase = {
    apps: [],
    initializeApp(config) {
      if (!this.apps.length) this.apps.push({ name: '[DEFAULT]', options: config });
      // Inicializar cliente Supabase con las variables globales
      getClient();
      return this.apps[0];
    },
    database() { return makeDB(); },
    auth() {
      return {
        onAuthStateChanged(cb) { cb(null); },
        currentUser: null
      };
    }
  };

  console.log('✓ supabase-firebase-shim.js cargado');

})();
