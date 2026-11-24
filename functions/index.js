/* ═══════════════════════════════════════════════════════════════
   Dent Flow — إشعارات الدفع (Web Push)

   تصل الإشعارات إلى الهاتف أو الحاسبة حتى والبرنامج مغلق تماماً.
   السيرفر يراقب أحداثاً في Firestore ويرسل إشعاراً لأصحابها:

   للعيادة (الطبيب والسكرتير):
     ١) حجز جديد من تطبيق المراجع                → أطباء العيادة وسكرتاريتها
     ٢) ألغى المراجع حجزه                         → أطباء العيادة وسكرتاريتها
     ٣) تحويل مراجع إلى طبيب في قسم «اليوم»       → الطبيب المحوَّل إليه
     ٤) تحديد طبيب لمراجع «بدون طبيب»             → الطبيب المختار
     ٥) السكرتير أضاف مراجعاً لقائمة طبيب اليوم    → ذلك الطبيب
   للمراجع (تطبيق «مواعيدي»):
     ٦) قبول حجزه أو الاعتذار عنه
     ٧) تحديد موعد له أو تغيير يومه أو ساعته

   كل جهاز وافق على الإشعارات يحفظ «اشتراكه» في:
     pushsubs/{uid}/d/{sid}   (sid = بصمة عنوان الاشتراك)
   والقواعد تمنع أي حساب من قراءة اشتراك غيره.

   مفاتيح VAPID (هوية مرسل الإشعارات) تُولَّد هنا تلقائياً عند أول
   حاجة وتُحفظ في config/vapid الذي لا يقرؤه إلا المشرف. المفتاح العام
   وحده يُنشر في meta/push لتقرأه البرامج — فلا مفتاح سرّي في الكود.
   ═══════════════════════════════════════════════════════════ */

const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
const webpush = require('web-push');
const { FieldValue } = require('firebase-admin/firestore');

admin.initializeApp();
const db = admin.firestore();

/* الجيل الأول من الدوال: مشغّلات Firestore فيه تعمل أيّاً كان موقع
   قاعدة البيانات، فلا يتعطّل النشر بسبب اختلاف المنطقة. */
const fn = functions.runWith({ memory: '256MB', timeoutSeconds: 60 });

/*──── مفاتيح VAPID ────*/
let VAPID = null;
async function vapid() {
  if (VAPID) return VAPID;
  const ref = db.doc('config/vapid');
  VAPID = await db.runTransaction(async tx => {
    const s = await tx.get(ref);
    if (s.exists && s.data().publicKey && s.data().privateKey) return s.data();
    const k = webpush.generateVAPIDKeys();
    tx.set(ref, { publicKey: k.publicKey, privateKey: k.privateKey,
                  created_at: FieldValue.serverTimestamp() });
    return k;
  });
  webpush.setVapidDetails('mailto:noreply@dentflow.app', VAPID.publicKey, VAPID.privateKey);
  /* المفتاح العام منشور للبرامج — يُكتب كل مرة يبدأ فيها السيرفر (رخيص ومضمون) */
  await db.doc('meta/push').set({ publicKey: VAPID.publicKey,
    u: FieldValue.serverTimestamp() }, { merge: true });
  return VAPID;
}

/*──── الإرسال ────
  لكل مستلم كل أجهزته. الاشتراك المنتهي (404/410) يُحذف فوراً
  فلا يتكرّر الفشل عليه. */
async function sendTo(uids, msg) {
  uids = [...new Set((uids || []).filter(Boolean))];
  if (!uids.length) return 0;
  await vapid();
  const body = JSON.stringify({
    title: String(msg.title || 'Dent Flow').slice(0, 120),
    body: String(msg.body || '').slice(0, 400),
    tag: msg.tag || undefined,
    url: msg.url || './',
    kind: msg.kind || '',
  });
  let sent = 0;
  await Promise.all(uids.map(async uid => {
    const subs = await db.collection('pushsubs').doc(uid).collection('d').get();
    await Promise.all(subs.docs.map(async d => {
      const s = d.data();
      if (!s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) { await d.ref.delete(); return; }
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body,
          { TTL: 24 * 3600, urgency: 'high', topic: msg.topic || undefined });
        sent++;
      } catch (e) {
        const c = e && e.statusCode;
        if (c === 404 || c === 410 || c === 403) await d.ref.delete().catch(() => {});
        else functions.logger.warn('push failed', { uid, code: c, msg: String(e && e.message || e) });
      }
    }));
  }));
  return sent;
}

/*──── أدوات ────*/
const nameOf = d => (d && (String(d.name || '').trim()
  || [d.n1, d.n2, d.n3, d.n4].filter(Boolean).join(' ').trim())) || 'مراجع';

async function clinicName(cid) {
  try {
    const c = (await db.doc('clinics/' + cid).get()).data() || {};
    return c.app_name || c.name || 'العيادة';
  } catch (_) { return 'العيادة'; }
}

async function staffOf(cid, roles) {
  const q = await db.collection('members').where('cid', '==', cid).get();
  return q.docs.filter(d => {
    const m = d.data();
    return m.active !== false && roles.includes(m.role);
  }).map(d => d.id);
}

async function roleOf(uid) {
  if (!uid) return null;
  try { return ((await db.doc('members/' + uid).get()).data() || {}).role || null; }
  catch (_) { return null; }
}

/* «2026-11-25» ← يوم مقروء بالعربية */
function dayAr(d) {
  if (!d) return '';
  const x = new Date(String(d) + 'T12:00:00Z');
  if (isNaN(x)) return String(d);
  try {
    return x.toLocaleDateString('ar-IQ', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  } catch (_) { return String(d); }
}
const when = (day, time) => [dayAr(day), time ? 'الساعة ' + time : ''].filter(Boolean).join(' ');

/*═══════ ١ و٢ و٦: الحجوزات ═══════*/
exports.onBookingCreated = fn.firestore.document('clinics/{cid}/bookings/{bid}')
  .onCreate(async (snap, ctx) => {
    const b = snap.data() || {};
    if (b.status !== 'pending') return;
    const doc = b.doc || {};
    const staff = await staffOf(ctx.params.cid, ['doctor', 'secretary']);
    const w = when(doc.day, doc.time);
    await sendTo(staff, {
      title: '📅 حجز جديد',
      body: `${nameOf(doc)}${w ? ' — ' + w : ''}${doc.complaint ? '\n' + String(doc.complaint).slice(0, 120) : ''}`,
      tag: 'bk-' + ctx.params.bid, url: './?go=book', kind: 'booking',
    });
  });

exports.onBookingUpdated = fn.firestore.document('clinics/{cid}/bookings/{bid}')
  .onUpdate(async (ch, ctx) => {
    const a = ch.before.data() || {}, b = ch.after.data() || {};
    if (a.status === b.status) return;
    const doc = b.doc || {};
    const { cid, bid } = ctx.params;

    /* قرار العيادة ← المراجع */
    if (a.status === 'pending' && (b.status === 'accepted' || b.status === 'declined') && b.pu) {
      const cn = await clinicName(cid);
      const w = when(doc.day, doc.time);
      await sendTo([b.pu], b.status === 'accepted'
        ? { title: '✅ تم قبول حجزك', body: `${cn}${w ? ' — موعدك ' + w : ''}`,
            tag: 'bk-' + bid, url: './?go=care', kind: 'bk-ok' }
        : { title: 'تعذّر قبول حجزك', body: `${cn} — يمكنك اختيار موعد آخر من التطبيق`,
            tag: 'bk-' + bid, url: './?go=home', kind: 'bk-no' });
      return;
    }

    /* ألغى المراجع ← العيادة */
    if (b.status === 'cancelled' && (a.status === 'pending' || a.status === 'accepted')) {
      const staff = await staffOf(cid, ['doctor', 'secretary']);
      const w = when(doc.day, doc.time);
      await sendTo(staff, {
        title: 'ألغى المراجع حجزه', body: `${nameOf(doc)}${w ? ' — ' + w : ''}`,
        tag: 'bk-' + bid, url: './?go=book', kind: 'bk-cancel',
      });
    }
  });

/*═══════ ٣ و٤ و٥: لوحة اليوم ═══════
  لوحة اليوم المشتركة clinics/{cid}/board/{vid} تحمل لكل جلسة اليوم:
  الاسم n، طبيب الملف k ('_' = بدون طبيب)، الطبيب المعالج dr، ومن كتب by.
  ولا تحمل أي بيانات سريرية. */
exports.onBoardWrite = fn.firestore.document('clinics/{cid}/board/{vid}')
  .onWrite(async (ch, ctx) => {
    if (!ch.after.exists) return;
    const a = ch.before.exists ? ch.before.data() : null;
    const b = ch.after.data() || {};
    const by = b.by || null;
    const name = String(b.n || 'مراجع');
    const tag = 'q-' + ctx.params.vid;

    /* تحويل أو تحديد طبيب: تغيّر الطبيب المعالج */
    if (b.dr && b.dr !== (a && a.dr) && b.dr !== by) {
      const free = !b.k || b.k === '_';
      await sendTo([b.dr], {
        title: free ? '🦷 حُدِّد لك مراجع' : '⇄ حُوِّل إليك مراجع',
        body: `${name} — في قائمة اليوم`, tag, url: './?go=today', kind: free ? 'assign' : 'transfer',
      });
      return;
    }

    /* جلسة جديدة اليوم لمراجع طبيب بعينه، أضافها السكرتير */
    if (!a && !b.dr && b.k && b.k !== '_' && b.k !== by && (b.q || 'waiting') === 'waiting'
        && await roleOf(by) === 'secretary') {
      await sendTo([b.k], {
        title: '👤 مراجع جديد في قائمتك', body: `${name} — بالانتظار`,
        tag, url: './?go=today', kind: 'queue',
      });
    }
  });

/*═══════ ٧: مواعيد المراجع ═══════
  العيادة تنسخ مواعيد المراجع إلى حسابه في patients/{pu}/care/... */
exports.onCareWrite = fn.firestore.document('patients/{pu}/care/{key}')
  .onWrite(async (ch, ctx) => {
    if (!ch.after.exists) return;
    const b = ch.after.data() || {};
    if (b.store !== 'appts' || b.st !== 'open' || !b.day) return;
    const a = ch.before.exists ? ch.before.data() : null;
    if (a && a.day === b.day && (a.time || '') === (b.time || '') && a.st === 'open') return;
    /* موعد من حجز قُبل للتو: إشعار القبول يحمل الموعد نفسه — لا تكرار */
    if (!a && String(b.rid || '').startsWith('bk_')) return;
    const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);   /* توقيت العراق */
    if (b.day < today) return;
    const cn = b.clinic || await clinicName(b.cid);
    await sendTo([ctx.params.pu], {
      title: a ? '🔁 تغيّر موعدك' : '📅 موعد جديد لك',
      body: `${cn} — ${when(b.day, b.time)}${b.note ? '\n' + String(b.note).slice(0, 120) : ''}`,
      tag: 'ap-' + ctx.params.key, url: './?go=care', kind: 'appt',
    });
  });

/* تهيئة المفاتيح يدوياً عند الحاجة (تُستدعى مرة بعد النشر — اختيارية:
   المفاتيح تُولَّد وحدها أيضاً مع أول حدث) */
exports.pushInit = fn.https.onRequest(async (req, res) => {
  const k = await vapid();
  res.set('Cache-Control', 'no-store').json({ ok: true, publicKey: k.publicKey });
});
