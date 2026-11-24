/* ═══════════════════════════════════════════════════════════════
   Dent Flow — عامل الخدمة

   وجوده شرط عند متصفحات سطح المكتب لعرض زر «تثبيت» مباشر.
   بدونه لا يُطلق المتصفح حدث التثبيت، فلا يبقى للبرنامج إلا أن
   يشرح للمستخدم كيف يثبّت يدوياً من القائمة.

   لا يخزّن شيئاً مؤقتاً عن قصد: البرنامج ملف واحد يتغيّر مع كل
   تحديث، والتخزين المؤقت الخاطئ يُبقي المستخدم على نسخة قديمة
   دون أن يدري — وهذا أسوأ من بطء التحميل.
   ═══════════════════════════════════════════════════════════ */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* معالج الجلب مطلوب لتحقّق شروط التثبيت — يمرّر الطلب كما هو */
self.addEventListener('fetch', e => {
  /* الطلبات غير GET (رفع الصور، نداءات السيرفر) لا تُلمس */
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() =>
      caches.match(e.request).then(r => r || Response.error()))
  );
});

/*──── إشعارات الدفع ────
  تصل من سيرفر Firebase (Cloud Functions) حتى والبرنامج مغلق.
  الحمولة: { title, body, tag, url, kind } */
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; }
  catch (_) { m = { body: e.data ? e.data.text() : '' }; }
  const base = self.registration.scope;
  const url = new URL(m.url || './', base).href;
  e.waitUntil(self.registration.showNotification(m.title || 'Dent Flow', {
    body: m.body || '',
    tag: m.tag || undefined,
    renotify: !!m.tag,
    icon: new URL('icons/icon-192.png', base).href,
    badge: new URL('icons/favicon-32.png', base).href,
    dir: 'rtl', lang: 'ar',
    data: { url, kind: m.kind || '' },
  }));
});

/* الضغط على الإشعار: يُفتح البرنامج (أو يُستعاد إن كان مفتوحاً) على الشاشة المناسبة */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = all.find(c => c.url.startsWith(self.registration.scope));
    if (mine) {
      try { mine.postMessage({ type: 'push-open', url }); } catch (_) {}
      return mine.focus();
    }
    return self.clients.openWindow(url);
  })());
});

/* المتصفح جدّد الاشتراك بنفسه: يُبلَّغ البرنامج ليحفظ الجديد عند فتحه */
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil(self.clients.matchAll({ type: 'window' })
    .then(cs => cs.forEach(c => { try { c.postMessage({ type: 'push-renew' }); } catch (_) {} })));
});
