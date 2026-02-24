import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import QRCode from "qrcode";
import { auth, db } from "./firebase";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "firebase/firestore";

/**
 * Student360 (Commercial-ready MVP - Firebase)
 *
 * Storage:
 *   schools/{schoolId}
 *   schools/{schoolId}/students/{studentId}
 *   schools/{schoolId}/students/{studentId}/notes/{noteId}
 *
 * AUTH (FIXED):
 * - Removed Anonymous auth entirely.
 * - Real sign-in via Email/Password.
 * - Role is loaded from Firestore: /users/{uid} => { role, email }
 */

const SCHOOL_ID = "demo-school";
const SCHOOL_NAME = "Demo School";

/** Deploy badge */
const DEPLOY_BADGE_TEXT = "Deployed on Vercel ✅";

export default function App() {
  // ========= Firebase Auth =========
  const [fbReady, setFbReady] = useState(false);
  const [fbUser, setFbUser] = useState(null);

  // ========= Session (from Firebase + Firestore role doc) =========
  const [session, setSession] = useState(null); // { role, name, identifier, schoolId, schoolName, uid }

  // ========= App Pages =========
  const [page, setPage] = useState("dashboard"); // dashboard | scanner | student | admin_students
  const [student, setStudent] = useState(null);
  const [studentLoadError, setStudentLoadError] = useState("");

  // sessionId to cancel old scanner callbacks
  const scanSessionRef = useRef(0);

  // Paths
  const schoolDocRef = useMemo(
    () => doc(db, "schools", session?.schoolId || "x"),
    [session?.schoolId]
  );

  function studentDocRef(studentId) {
    return doc(db, "schools", session.schoolId, "students", studentId);
  }
  function notesColRef(studentId) {
    return collection(
      db,
      "schools",
      session.schoolId,
      "students",
      studentId,
      "notes"
    );
  }

  // ========= Effects (ALL hooks before any return) =========

  // Auth state listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setFbUser(u || null);
      setFbReady(true);
    });
    return () => unsub();
  }, []);

  // Load role/session from Firestore when authenticated
  useEffect(() => {
    if (!fbReady) return;

    // Logged out
    if (!fbUser) {
      setSession(null);
      return;
    }

    // Logged in: fetch /users/{uid}
    (async () => {
      try {
        const roleRef = doc(db, "users", fbUser.uid);
        const snap = await getDoc(roleRef);

        if (!snap.exists()) {
          // User exists in Auth but has no role doc
          // This will happen if /users/{uid} was not created.
          setSession({
            uid: fbUser.uid,
            role: "unknown",
            name: "مستخدم",
            identifier: fbUser.email || fbUser.uid,
            schoolId: SCHOOL_ID,
            schoolName: SCHOOL_NAME,
          });
          return;
        }

        const data = snap.data() || {};
        const role = data.role || "unknown";
        const email = data.email || fbUser.email || fbUser.uid;

        setSession({
          uid: fbUser.uid,
          role,
          name: ROLE_DEFAULT_NAMES[role] || "مستخدم",
          identifier: email,
          schoolId: SCHOOL_ID,
          schoolName: SCHOOL_NAME,
        });
      } catch (e) {
        console.error(e);
        setSession({
          uid: fbUser.uid,
          role: "unknown",
          name: "مستخدم",
          identifier: fbUser.email || fbUser.uid,
          schoolId: SCHOOL_ID,
          schoolName: SCHOOL_NAME,
        });
      }
    })();
  }, [fbReady, fbUser]);

  // Ensure school doc exists (Admin only)
  useEffect(() => {
    if (!session) return;
    if (!fbReady) return;
    if (session.role !== "admin") return;

    (async () => {
      try {
        await setDoc(
          schoolDocRef,
          {
            schoolId: session.schoolId,
            name: session.schoolName,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } catch (e) {
        console.error(e);
      }
    })();
  }, [session, fbReady, schoolDocRef]);

  // ========= Navigation helpers =========
  async function signOut() {
    try {
      await firebaseSignOut(auth);
    } catch (e) {
      console.error(e);
    } finally {
      // session will be cleared by onAuthStateChanged
      scanSessionRef.current += 1;
      setStudent(null);
      setStudentLoadError("");
      setPage("dashboard");
    }
  }

  function goDashboard() {
    scanSessionRef.current += 1;
    setStudent(null);
    setStudentLoadError("");
    setPage("dashboard");
  }

  function goScanner() {
    scanSessionRef.current += 1;
    setStudent(null);
    setStudentLoadError("");
    setPage("scanner");
  }

  function goAdminStudents() {
    scanSessionRef.current += 1;
    setStudent(null);
    setStudentLoadError("");
    setPage("admin_students");
  }

  async function openStudentById(studentIdRaw, currentScanSessionId) {
    if (currentScanSessionId !== scanSessionRef.current) return;

    const sid = normalizeStudentId(studentIdRaw);
    if (!sid) {
      setStudent(null);
      setStudentLoadError(
        "QR غير صالح. لازم يحتوي StudentID فقط مثل: S-10025 أو 10025"
      );
      setPage("student");
      return;
    }

    try {
      setStudentLoadError("");
      const snap = await getDoc(studentDocRef(sid));

      if (!snap.exists()) {
        setStudent(null);
        setStudentLoadError(
          `لم يتم العثور على طالب بهذا الـ ID: ${sid} داخل المدرسة.`
        );
        setPage("student");
        return;
      }

      setStudent({ studentId: sid, ...snap.data() });
      setPage("student");
    } catch (e) {
      console.error(e);
      setStudent(null);
      setStudentLoadError("حصل خطأ أثناء جلب بيانات الطالب من Firebase.");
      setPage("student");
    }
  }

  // ========= Guards =========

  // Not ready yet
  if (!fbReady) {
    return (
      <CenterMessage
        title="Student360"
        message="جاري تجهيز الاتصال بـ Firebase..."
      />
    );
  }

  // Logged out -> show real login
  if (!fbUser) {
    return <Login />;
  }

  // Logged in but session still loading
  if (!session) {
    return (
      <CenterMessage
        title="Student360"
        message="جاري تحميل صلاحيات الحساب (Role) من Firestore..."
      />
    );
  }

  // If role doc missing / unknown
  if (session.role === "unknown") {
    return (
      <CenterMessage
        title="Student360"
        message={
          "تم تسجيل الدخول بنجاح، لكن لم يتم العثور على Role لهذا المستخدم في Firestore.\n" +
          "تأكد أن لديك Document داخل /users/{UID} يحتوي على الحقل role."
        }
      />
    );
  }

  // ========= Pages =========
  if (page === "dashboard") {
    return (
      <Dashboard
        session={session}
        onSignOut={signOut}
        onScanQR={goScanner}
        onAdminStudents={goAdminStudents}
      />
    );
  }

  if (page === "admin_students") {
    return (
      <AdminStudents
        session={session}
        onBack={goDashboard}
        onGoScanner={goScanner}
        studentDocRef={studentDocRef}
      />
    );
  }

  if (page === "scanner") {
    return (
      <QRScanner
        sessionId={scanSessionRef.current}
        onGoDashboard={goDashboard}
        onScan={(text, sid) => openStudentById(text, sid)}
      />
    );
  }

  return (
    <StudentPage
      session={session}
      student={student}
      error={studentLoadError}
      onGoDashboard={goDashboard}
      onRescan={goScanner}
      notesColRef={notesColRef}
    />
  );
}

/* ===================== LOGIN (REAL FIREBASE) ===================== */
function Login() {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function mapAuthError(err) {
    const code = String(err?.code || "");
    if (code.includes("auth/invalid-credential")) return "بيانات الدخول غير صحيحة.";
    if (code.includes("auth/wrong-password")) return "كلمة المرور غير صحيحة.";
    if (code.includes("auth/user-not-found")) return "المستخدم غير موجود.";
    if (code.includes("auth/invalid-email")) return "البريد الإلكتروني غير صحيح.";
    if (code.includes("auth/too-many-requests"))
      return "محاولات كثيرة. انتظر قليلًا ثم جرّب.";
    if (code.includes("auth/admin-restricted-operation"))
      return "عملية مرفوضة. (تأكد أن هذا تسجيل دخول وليس إنشاء مستخدم).";
    return "تعذر تسجيل الدخول. راجع Console للتفاصيل.";
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    const email = identifier.trim();
    if (!email) return setError("فضلاً اكتب البريد الإلكتروني.");
    if (!password) return setError("فضلاً اكتب كلمة المرور.");

    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      // session is set by App via onAuthStateChanged + role doc
    } catch (err) {
      console.error(err);
      setError(mapAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.brandRow}>
          <div style={styles.logo}>S360</div>
          <div>
            <h1 style={styles.title}>Student360</h1>
            <p style={styles.subtitle}>تسجيل الملاحظات السلوكية بسرعة عبر QR</p>
            <div style={styles.deployBadge}>{DEPLOY_BADGE_TEXT}</div>
          </div>
        </div>

        <form style={styles.form} onSubmit={handleSubmit}>
          <label style={styles.label}>
            البريد الإلكتروني
            <input
              style={styles.input}
              placeholder="admin@demo.sa"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </label>

          <label style={styles.label}>
            كلمة المرور
            <input
              style={styles.input}
              type="password"
              placeholder="123456"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error ? <div style={styles.errorBox}>{error}</div> : null}

          <button style={styles.button} type="submit" disabled={busy}>
            {busy ? "جاري تسجيل الدخول..." : "تسجيل الدخول"}
          </button>

          <div style={styles.demoBox}>
            <div style={styles.demoTitle}>بيانات ديمو للاختبار السريع</div>
            <div style={styles.demoRow}>
              <span style={styles.badge}>admin</span>
              <span style={styles.demoText}>
                المستخدم: <b>admin@demo.sa</b>
              </span>
            </div>
            <div style={styles.demoRow}>
              <span style={styles.badge}>teacher</span>
              <span style={styles.demoText}>
                المستخدم: <b>teacher@demo.sa</b>
              </span>
            </div>
            <div style={styles.demoRow}>
              <span style={styles.badge}>counselor</span>
              <span style={styles.demoText}>
                المستخدم: <b>counselor@demo.sa</b>
              </span>
            </div>
            <div style={styles.demoRow}>
              <span style={styles.badge}>parent</span>
              <span style={styles.demoText}>
                المستخدم: <b>parent@demo.sa</b>
              </span>
            </div>
            <div style={styles.demoRow}>
              <span style={styles.badge}>كلمة المرور</span>
              <span style={styles.demoText}>
                <b>123456</b>
              </span>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ===================== DASHBOARD ===================== */
function Dashboard({ session, onSignOut, onScanQR, onAdminStudents }) {
  const roleLabel = ROLE_LABELS[session.role] ?? "—";

  const cards = useMemo(() => {
    const base = ROLE_CARDS[session.role] ?? [];
    if (session.role === "admin") {
      return [
        {
          key: "students",
          title: "إدارة الطلاب",
          desc: "إضافة/استيراد الطلاب + توليد QR + طباعة.",
          cta: "فتح",
          action: onAdminStudents,
        },
        {
          key: "scan",
          title: "مسح QR (اختياري)",
          desc: "لو المدير احتاج يمسح QR بنفسه.",
          cta: "فتح",
          action: onScanQR,
        },
        ...base,
      ];
    }
    return base;
  }, [session.role, onAdminStudents, onScanQR]);

  return (
    <div style={styles.page}>
      <div style={styles.shell}>
        <header style={styles.topbar}>
          <div style={styles.brand}>
            <div style={styles.logoSm}>S360</div>
            <div>
              <div style={styles.brandTitle}>Student360</div>
              <div style={styles.brandSub}>
                {session.schoolName} — {roleLabel} — {session.name}
              </div>
              <div style={styles.deployBadge}>{DEPLOY_BADGE_TEXT}</div>
            </div>
          </div>

          <button style={styles.ghostBtn} onClick={onSignOut}>
            تسجيل خروج
          </button>
        </header>

        <main style={styles.main}>
          <div style={styles.grid}>
            {cards.map((c) => (
              <Card
                key={c.key}
                title={c.title}
                desc={c.desc}
                cta={c.cta}
                onClick={() => (c.action ? c.action() : alert("قريبًا"))}
              />
            ))}
          </div>

          <div style={styles.noteBox}>
            <div style={styles.noteTitle}>مهم</div>
            <div style={styles.noteText}>
              ✅ التخزين أصبح Multi-School جاهز للبيع
              <br />
              ✅ الطلاب فريدين بـ StudentID (ممنوع التكرار تلقائيًا)
              <br />
              ✅ QR Generation داخل البرنامج + Import CSV
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function Card({ title, desc, cta, onClick }) {
  return (
    <div style={styles.cardBox}>
      <div style={styles.cardTitle}>{title}</div>
      <div style={styles.cardDesc}>{desc}</div>
      <button style={styles.cardBtn} onClick={onClick}>
        {cta}
      </button>
    </div>
  );
}

/* ===================== ADMIN: STUDENTS + IMPORT + QR ===================== */
function AdminStudents({ session, onBack, onGoScanner, studentDocRef }) {
  const [studentId, setStudentId] = useState("");
  const [fullName, setFullName] = useState("");
  const [grade, setGrade] = useState("الصف الأول ابتدائي");
  const [section, setSection] = useState("أ");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const [latest, setLatest] = useState([]);
  const [loadingLatest, setLoadingLatest] = useState(false);

  // QR modal
  const [qrOpen, setQrOpen] = useState(false);
  const [qrFor, setQrFor] = useState(null); // {studentId,name}
  const [qrDataUrl, setQrDataUrl] = useState("");

  async function loadLatest() {
    setLoadingLatest(true);
    setMsg("");
    try {
      const q = query(
        collection(db, "schools", session.schoolId, "students"),
        orderBy("createdAt", "desc"),
        limit(20)
      );
      const snap = await getDocs(q);
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setLatest(items);
    } catch (e) {
      console.error(e);
      setMsg("تعذر تحميل قائمة الطلاب (راجع Console).");
    } finally {
      setLoadingLatest(false);
    }
  }

  useEffect(() => {
    loadLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createStudent() {
    setMsg("");

    if (session.role !== "admin") {
      return setMsg("صلاحيات غير كافية. إضافة الطلاب للمدير فقط.");
    }

    const sid = normalizeStudentId(studentId);
    if (!sid) return setMsg("اكتب StudentID صحيح (مثال: S-10025 أو 10025).");
    if (!fullName.trim()) return setMsg("اكتب اسم الطالب.");
    setSaving(true);

    try {
      const ref = studentDocRef(sid);
      const exists = await getDoc(ref);
      if (exists.exists()) {
        setMsg(`⚠️ هذا الطالب موجود بالفعل (StudentID: ${sid}).`);
        return;
      }

      await setDoc(ref, {
        schoolId: session.schoolId,
        studentId: sid,
        name: fullName.trim(),
        grade,
        section,
        createdAt: serverTimestamp(),
        createdBy: {
          role: session.role,
          name: session.name,
          identifier: session.identifier,
        },
      });

      setMsg(`✅ تم إضافة الطالب. الآن يمكنك توليد QR للـ StudentID: ${sid}`);
      setStudentId("");
      setFullName("");
      await loadLatest();
    } catch (e) {
      console.error(e);
      setMsg("❌ حصل خطأ أثناء إضافة الطالب (راجع Console).");
    } finally {
      setSaving(false);
    }
  }

  async function openQR(s) {
    try {
      const text = s.studentId; // QR content = studentId only
      const url = await QRCode.toDataURL(text, { margin: 2, scale: 8 });
      setQrFor({ studentId: s.studentId, name: s.name });
      setQrDataUrl(url);
      setQrOpen(true);
    } catch (e) {
      console.error(e);
      setMsg("تعذر توليد QR.");
    }
  }

  function downloadQR() {
    if (!qrDataUrl || !qrFor) return;
    const a = document.createElement("a");
    a.href = qrDataUrl;
    a.download = `Student360_${qrFor.studentId}.png`;
    a.click();
  }

  function printQR() {
    if (!qrDataUrl || !qrFor) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`
      <html>
        <head><title>Print QR</title></head>
        <body style="font-family:Arial; text-align:center; padding:30px;">
          <h2 style="margin:0 0 8px;">${escapeHtml(qrFor.name || "")}</h2>
          <div style="margin-bottom:10px; font-weight:bold;">StudentID: ${escapeHtml(
            qrFor.studentId
          )}</div>
          <img src="${qrDataUrl}" style="width:260px; height:260px;" />
          <div style="margin-top:14px; color:#555;">Student360</div>
          <script>window.onload = () => window.print();</script>
        </body>
      </html>
    `);
    w.document.close();
  }

  async function importCSV(file) {
    setMsg("");
    if (!file) return;

    if (session.role !== "admin") {
      return setMsg("صلاحيات غير كافية. الاستيراد للمدير فقط.");
    }

    try {
      const text = await file.text();
      const rows = parseCSV(text);

      const cleaned = rows
        .map((r) => ({
          studentId: normalizeStudentId(
            r.studentId || r.StudentID || r.id || r.ID
          ),
          name: (r.name || r.Name || "").trim(),
          grade: (r.grade || r.Grade || "الصف الأول ابتدائي").trim(),
          section: (r.section || r.Section || "أ").trim(),
        }))
        .filter((x) => x.studentId && x.name);

      if (cleaned.length === 0) {
        return setMsg(
          "ملف CSV لا يحتوي بيانات صحيحة. لازم أعمدة: studentId,name,grade,section"
        );
      }

      const batch = writeBatch(db);
      cleaned.slice(0, 200).forEach((s) => {
        const ref = studentDocRef(s.studentId);
        batch.set(
          ref,
          {
            schoolId: session.schoolId,
            studentId: s.studentId,
            name: s.name,
            grade: s.grade,
            section: s.section,
            createdAt: serverTimestamp(),
            createdBy: {
              role: session.role,
              name: session.name,
              identifier: session.identifier,
              via: "csv",
            },
          },
          { merge: false }
        );
      });

      await batch.commit();
      setMsg(
        `✅ تم استيراد ${Math.min(
          cleaned.length,
          200
        )} طالب. (الحد 200 دفعة واحدة للتجربة)`
      );
      await loadLatest();
    } catch (e) {
      console.error(e);
      setMsg("❌ فشل استيراد CSV. راجع Console.");
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.shell}>
        <header style={styles.topbar}>
          <div style={styles.brand}>
            <div style={styles.logoSm}>S360</div>
            <div>
              <div style={styles.brandTitle}>إدارة الطلاب</div>
              <div style={styles.brandSub}>
                {session.schoolName} — {ROLE_LABELS[session.role] || session.role}
              </div>
              <div style={styles.deployBadge}>{DEPLOY_BADGE_TEXT}</div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={styles.ghostBtn} onClick={onBack}>
              رجوع للوحة
            </button>
            <button style={styles.ghostBtn} onClick={onGoScanner}>
              مسح QR
            </button>
          </div>
        </header>

        <main style={styles.main}>
          <div style={styles.twoCols}>
            <div style={styles.panel}>
              <div style={styles.panelTitle}>إضافة طالب</div>

              <label style={styles.label}>
                StudentID (هو اللي داخل QR)
                <input
                  style={styles.input}
                  value={studentId}
                  onChange={(e) => setStudentId(e.target.value)}
                  placeholder="S-10025"
                />
                <div style={styles.miniHint}>QR محتواه: StudentID فقط</div>
              </label>

              <label style={styles.label}>
                اسم الطالب
                <input
                  style={styles.input}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="محمد أحمد"
                />
              </label>

              <label style={styles.label}>
                الصف
                <select
                  style={styles.select}
                  value={grade}
                  onChange={(e) => setGrade(e.target.value)}
                >
                  <option>الصف الأول ابتدائي</option>
                  <option>الصف الثاني ابتدائي</option>
                  <option>الصف الثالث ابتدائي</option>
                  <option>الصف الرابع ابتدائي</option>
                  <option>الصف الخامس ابتدائي</option>
                  <option>الصف السادس ابتدائي</option>
                  <option>الصف الأول متوسط</option>
                  <option>الصف الثاني متوسط</option>
                  <option>الصف الثالث متوسط</option>
                  <option>الصف الأول ثانوي</option>
                  <option>الصف الثاني ثانوي</option>
                  <option>الصف الثالث ثانوي</option>
                </select>
              </label>

              <label style={styles.label}>
                الشعبة
                <select
                  style={styles.select}
                  value={section}
                  onChange={(e) => setSection(e.target.value)}
                >
                  <option>أ</option>
                  <option>ب</option>
                  <option>ج</option>
                  <option>د</option>
                </select>
              </label>

              {msg ? <div style={styles.infoBox}>{msg}</div> : null}

              <button
                style={styles.button}
                onClick={createStudent}
                disabled={saving}
              >
                {saving ? "جاري الحفظ..." : "إضافة الطالب"}
              </button>

              <div style={styles.note}>
                ✅ استيراد جماعي: من Excel اعمل Save As → CSV ثم ارفعه هنا.
              </div>

              <label style={{ ...styles.label, marginTop: 10 }}>
                استيراد CSV
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => importCSV(e.target.files?.[0])}
                />
                <div style={styles.miniHint}>
                  الأعمدة المطلوبة: studentId,name,grade,section
                </div>
              </label>
            </div>

            <div style={styles.panel}>
              <div style={styles.panelTitle}>قائمة الطلاب (آخر 20)</div>
              <button
                style={styles.secondaryBtn}
                onClick={loadLatest}
                disabled={loadingLatest}
              >
                {loadingLatest ? "تحميل..." : "تحديث القائمة"}
              </button>

              <div style={{ marginTop: 12 }}>
                {latest.length === 0 ? (
                  <div style={styles.miniHint}>لا يوجد طلاب بعد.</div>
                ) : (
                  latest.map((s) => (
                    <div key={s.id} style={styles.studentRow}>
                      <div>
                        <div style={{ fontWeight: 900 }}>{s.name}</div>
                        <div style={styles.miniHint}>
                          StudentID: <b>{s.studentId}</b> — {s.grade} — شعبة{" "}
                          {s.section}
                        </div>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <span style={styles.tag}>{s.studentId}</span>
                        <button
                          style={styles.secondaryBtn}
                          onClick={() => openQR(s)}
                        >
                          توليد QR
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {qrOpen ? (
                <div
                  style={styles.modalOverlay}
                  onClick={() => setQrOpen(false)}
                >
                  <div
                    style={styles.modal}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                        alignItems: "center",
                      }}
                    >
                      <div style={{ fontWeight: 900 }}>QR للطالب</div>
                      <button
                        style={styles.ghostBtn}
                        onClick={() => setQrOpen(false)}
                      >
                        إغلاق
                      </button>
                    </div>

                    <div style={{ marginTop: 10, fontWeight: 900 }}>
                      {qrFor?.name}
                    </div>
                    <div style={styles.miniHint}>
                      StudentID: {qrFor?.studentId}
                    </div>

                    {qrDataUrl ? (
                      <div style={{ textAlign: "center", marginTop: 12 }}>
                        <img
                          src={qrDataUrl}
                          alt="QR"
                          style={{ width: 260, height: 260 }}
                        />
                      </div>
                    ) : null}

                    <div
                      style={{
                        display: "flex",
                        gap: 10,
                        marginTop: 12,
                        flexWrap: "wrap",
                      }}
                    >
                      <button style={styles.primaryBtn} onClick={downloadQR}>
                        تحميل PNG
                      </button>
                      <button style={styles.secondaryBtn} onClick={printQR}>
                        طباعة
                      </button>
                    </div>

                    <div style={styles.note}>
                      QR محتواه StudentID فقط لسرعة المسح.
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

/* ===================== QR SCANNER ===================== */
function QRScanner({ sessionId, onGoDashboard, onScan }) {
  const videoRef = useRef(null);
  const readerRef = useRef(null);

  const didScanRef = useRef(false);
  const pendingTimeoutRef = useRef(null);

  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  function clearPending() {
    if (pendingTimeoutRef.current) {
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }
  }

  function stopScanner() {
    clearPending();
    try {
      if (readerRef.current) readerRef.current.reset();
    } catch {}
  }

  async function startCameraAndScan() {
    setError("");
    setStatus("starting");
    didScanRef.current = false;

    try {
      if (!readerRef.current) readerRef.current = new BrowserMultiFormatReader();

      const videoEl = videoRef.current;
      if (!videoEl) throw new Error("video element not found");

      await readerRef.current.decodeFromConstraints(
        { video: { facingMode: "environment" } },
        videoEl,
        (result) => {
          if (!result) return;
          if (didScanRef.current) return;

          didScanRef.current = true;
          setStatus("scanned");
          const text = result.getText();
          stopScanner();

          clearPending();
          pendingTimeoutRef.current = setTimeout(() => {
            pendingTimeoutRef.current = null;
            onScan(text, sessionId);
          }, 120);
        }
      );

      setStatus("scanning");
    } catch (e) {
      setError(humanizeCameraError(e));
      setStatus("error");
    }
  }

  useEffect(() => () => stopScanner(), []);

  return (
    <div style={styles.page}>
      <div style={styles.cardWide}>
        <div style={styles.topRow}>
          <div>
            <div style={styles.h2}>مسح QR</div>
            <div style={styles.sub2}>QR يحتوي StudentID فقط (مثل S-10025)</div>
            <div style={styles.deployBadge}>{DEPLOY_BADGE_TEXT}</div>
          </div>

          <button
            style={styles.ghostBtn}
            onClick={() => {
              stopScanner();
              onGoDashboard();
            }}
          >
            رجوع للوحة
          </button>
        </div>

        <div style={styles.videoWrap}>
          <video
            ref={videoRef}
            style={styles.video}
            autoPlay
            muted
            playsInline
          />
        </div>

        {error ? <div style={styles.errorBox}>{error}</div> : null}

        <div style={styles.actionsRow}>
          <button
            style={styles.primaryBtn}
            onClick={startCameraAndScan}
            disabled={status === "scanning" || status === "starting"}
          >
            {status === "scanning"
              ? "✅ الكاميرا تعمل… امسح الكود"
              : "تشغيل الكاميرا"}
          </button>

          <button
            style={styles.secondaryBtn}
            onClick={() => {
              stopScanner();
              didScanRef.current = false;
              setStatus("idle");
              setError("");
            }}
          >
            إيقاف/إعادة
          </button>
        </div>

        <div style={styles.note}>
          iPhone: وافق على إذن الكاميرا ثم اضغط “تشغيل الكاميرا”.
        </div>
      </div>
    </div>
  );
}

/* ===================== STUDENT PAGE + NOTES ===================== */
function StudentPage({
  session,
  student,
  error,
  onGoDashboard,
  onRescan,
  notesColRef,
}) {
  const [noteType, setNoteType] = useState("positive");
  const [location, setLocation] = useState("الفصل");
  const [category, setCategory] = useState("سلوك");
  const [comment, setComment] = useState("");

  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const [notes, setNotes] = useState([]);
  const [loadingNotes, setLoadingNotes] = useState(false);

  async function loadNotes(studentId) {
    setLoadingNotes(true);
    try {
      const q = query(
        notesColRef(studentId),
        orderBy("createdAt", "desc"),
        limit(30)
      );
      const snap = await getDocs(q);
      setNotes(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingNotes(false);
    }
  }

  useEffect(() => {
    setMsg("");
    setNotes([]);
    if (student?.studentId) loadNotes(student.studentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student?.studentId]);

  async function saveNote() {
    setMsg("");
    if (!student?.studentId) return setMsg("لا يمكن إضافة ملاحظة بدون طالب صحيح.");
    if (!comment.trim()) return setMsg("اكتب الملاحظة/التفاصيل.");

    setSaving(true);
    try {
      await addDoc(notesColRef(student.studentId), {
        schoolId: session.schoolId,
        studentId: student.studentId,
        studentName: student.name,
        type: noteType,
        location,
        category,
        comment: comment.trim(),
        createdAt: serverTimestamp(),
        createdBy: {
          role: session.role,
          name: session.name,
          identifier: session.identifier,
        },
      });

      setComment("");
      setMsg("✅ تم حفظ الملاحظة.");
      await loadNotes(student.studentId);
    } catch (e) {
      console.error(e);
      setMsg("❌ فشل حفظ الملاحظة.");
    } finally {
      setSaving(false);
    }
  }

  const canWriteNotes =
    session.role === "teacher" ||
    session.role === "counselor" ||
    session.role === "admin";

  return (
    <div style={styles.page}>
      <div style={styles.shell}>
        <header style={styles.topbar}>
          <div style={styles.brand}>
            <div style={styles.logoSm}>S360</div>
            <div>
              <div style={styles.brandTitle}>صفحة الطالب</div>
              <div style={styles.brandSub}>
                {session.schoolName} — {ROLE_LABELS[session.role]} — {session.name}
              </div>
              <div style={styles.deployBadge}>{DEPLOY_BADGE_TEXT}</div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={styles.ghostBtn} onClick={onGoDashboard}>
              رجوع للوحة
            </button>
            <button style={styles.ghostBtn} onClick={onRescan}>
              مسح QR
            </button>
          </div>
        </header>

        <main style={styles.main}>
          {error ? <div style={styles.errorBox}>{error}</div> : null}

          {student ? (
            <div style={styles.twoCols}>
              <div style={styles.panel}>
                <div style={styles.panelTitle}>بيانات الطالب</div>
                <div style={styles.kv}>
                  <div style={styles.k}>
                    <b>StudentID:</b>
                  </div>
                  <div style={styles.v}>{student.studentId}</div>
                </div>
                <div style={styles.kv}>
                  <div style={styles.k}>
                    <b>الاسم:</b>
                  </div>
                  <div style={styles.v}>{student.name}</div>
                </div>
                <div style={styles.kv}>
                  <div style={styles.k}>
                    <b>الصف:</b>
                  </div>
                  <div style={styles.v}>{student.grade}</div>
                </div>
                <div style={styles.kv}>
                  <div style={styles.k}>
                    <b>الشعبة:</b>
                  </div>
                  <div style={styles.v}>{student.section}</div>
                </div>
                <div style={styles.note}>
                  ✅ QR محتواه: <b>{student.studentId}</b>
                </div>
              </div>

              <div style={styles.panel}>
                <div style={styles.panelTitle}>تسجيل ملاحظة</div>

                {!canWriteNotes ? (
                  <div style={styles.infoBox}>
                    هذا الدور لا يضيف ملاحظات حالياً.
                  </div>
                ) : (
                  <>
                    <div style={styles.actionsRow}>
                      <button
                        style={{
                          ...styles.secondaryBtn,
                          borderColor:
                            noteType === "positive" ? "#0b5cff" : "#dbe3ef",
                          fontWeight: 900,
                        }}
                        onClick={() => setNoteType("positive")}
                      >
                        ✅ إيجابي
                      </button>
                      <button
                        style={{
                          ...styles.secondaryBtn,
                          borderColor:
                            noteType === "negative" ? "#0b5cff" : "#dbe3ef",
                          fontWeight: 900,
                        }}
                        onClick={() => setNoteType("negative")}
                      >
                        ❌ سلبي
                      </button>
                    </div>

                    <div style={styles.twoMiniCols}>
                      <label style={styles.label}>
                        المكان
                        <select
                          style={styles.select}
                          value={location}
                          onChange={(e) => setLocation(e.target.value)}
                        >
                          <option>الفصل</option>
                          <option>الملعب</option>
                          <option>الممر</option>
                          <option>المسجد</option>
                          <option>المكتبة</option>
                          <option>المقصف</option>
                          <option>البوابة</option>
                        </select>
                      </label>

                      <label style={styles.label}>
                        التصنيف
                        <select
                          style={styles.select}
                          value={category}
                          onChange={(e) => setCategory(e.target.value)}
                        >
                          <option>سلوك</option>
                          <option>تأخير</option>
                          <option>انضباط</option>
                          <option>تعاون</option>
                          <option>مخالفة</option>
                          <option>اجتهاد</option>
                        </select>
                      </label>
                    </div>

                    <label style={styles.label}>
                      الملاحظة
                      <textarea
                        style={styles.textarea}
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder="اكتب تفاصيل الملاحظة..."
                      />
                    </label>

                    {msg ? <div style={styles.infoBox}>{msg}</div> : null}

                    <button
                      style={styles.button}
                      onClick={saveNote}
                      disabled={saving}
                    >
                      {saving ? "جاري الحفظ..." : "حفظ الملاحظة"}
                    </button>
                  </>
                )}

                <div style={{ marginTop: 14 }}>
                  <div style={{ fontWeight: 900, marginBottom: 8 }}>
                    آخر الملاحظات
                  </div>
                  {loadingNotes ? (
                    <div style={styles.miniHint}>تحميل...</div>
                  ) : notes.length === 0 ? (
                    <div style={styles.miniHint}>لا توجد ملاحظات بعد.</div>
                  ) : (
                    notes.map((n) => (
                      <div key={n.id} style={styles.noteItem}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 10,
                          }}
                        >
                          <div style={{ fontWeight: 900 }}>
                            {n.type === "positive" ? "✅ إيجابي" : "❌ سلبي"} —{" "}
                            {n.category}
                          </div>
                          <div style={styles.tag}>{n.location}</div>
                        </div>
                        <div
                          style={{
                            marginTop: 6,
                            color: "#1f2a37",
                            lineHeight: 1.6,
                          }}
                        >
                          {n.comment}
                        </div>
                        <div style={styles.miniHint}>
                          بواسطة: {n.createdBy?.name || "—"} (
                          {ROLE_LABELS[n.createdBy?.role] || "—"})
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div style={styles.panel}>
              <div style={styles.panelTitle}>لا يوجد طالب معروض</div>
              <div style={styles.note}>
                اضغط “مسح QR” وامسح كود يحتوي StudentID فقط.
                <br />
                لو الطالب غير موجود: ادخل بحساب المدير → إدارة الطلاب → أضفه.
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/* ===================== HELPERS ===================== */
function normalizeStudentId(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  const cleaned = t.replace(/\s+/g, "");
  if (
    cleaned.startsWith("{") ||
    cleaned.startsWith("http") ||
    cleaned.includes("://")
  )
    return "";
  const s = cleaned.toUpperCase();
  const m = s.match(/^S-?\d+$/) || s.match(/^\d+$/);
  if (!m) return "";
  return s.startsWith("S") ? s.replace(/^S-?/, "S-") : s;
}

function humanizeCameraError(e) {
  const name = e?.name || "";
  const msg = String(e?.message || e || "");
  if (name === "NotAllowedError" || /denied/i.test(msg))
    return "تم رفض إذن الكاميرا. اسمح بالكاميرا ثم جرّب.";
  if (name === "NotFoundError") return "لا توجد كاميرا متاحة على هذا الجهاز.";
  if (name === "NotReadableError")
    return "الكاميرا مستخدمة في تطبيق آخر. اقفله ثم جرّب.";
  return `تعذّر تشغيل الكاميرا. (${name || "Error"}) ${msg}`;
}

function CenterMessage({ title, message }) {
  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.brandRow}>
          <div style={styles.logo}>S360</div>
          <div>
            <div style={{ fontWeight: 900, fontSize: 20 }}>{title}</div>
            <div style={{ color: "#6b7280", marginTop: 6, whiteSpace: "pre-line" }}>
              {message}
            </div>
            <div style={styles.deployBadge}>{DEPLOY_BADGE_TEXT}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[m])
  );
}

function parseCSV(text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter(Boolean);
  if (lines.length === 0) return [];
  const headers = splitCSVLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = (cols[idx] ?? "").trim()));
    rows.push(obj);
  }
  return rows;
}

function splitCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && (i === 0 || line[i - 1] !== "\\")) {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/* ===================== DATA ===================== */
const ROLE_LABELS = {
  teacher: "المعلم",
  admin: "المدير",
  counselor: "التوجيه الطلابي",
  parent: "ولي الأمر",
};

const ROLE_DEFAULT_NAMES = {
  admin: "أ/ مدير المدرسة",
  teacher: "أ/ أحمد",
  counselor: "أ/ توجيه طلابي",
  parent: "ولي أمر",
};

const ROLE_CARDS = {
  teacher: [
    {
      key: "scan",
      title: "مسح QR",
      desc: "امسح كود الطالب لفتح صفحته وتسجيل ملاحظة.",
      cta: "ابدأ المسح",
      action: null,
    },
  ],
  admin: [],
  counselor: [
    {
      key: "scan",
      title: "مسح QR",
      desc: "امسح كود الطالب لفتح صفحته وتسجيل متابعة.",
      cta: "ابدأ المسح",
      action: null,
    },
  ],
  parent: [
    {
      key: "children",
      title: "أبنائي (قريبًا)",
      desc: "ربط الأبناء وعرض السجل.",
      cta: "قريبًا",
      action: null,
    },
  ],
};

/* ===================== STYLES ===================== */
const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    fontFamily: "Arial",
    background:
      "radial-gradient(1200px 500px at 50% -20%, #e9f2ff 0%, #ffffff 55%, #f7f9fc 100%)",
  },
  card: {
    width: "100%",
    maxWidth: 560,
    background: "#fff",
    border: "1px solid #eef2f7",
    borderRadius: 18,
    boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
    padding: 18,
  },
  cardWide: {
    width: "100%",
    maxWidth: 760,
    background: "#fff",
    border: "1px solid #eef2f7",
    borderRadius: 18,
    boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
    padding: 18,
  },
  brandRow: { display: "flex", gap: 12, alignItems: "center", marginBottom: 14 },
  logo: {
    width: 52,
    height: 52,
    borderRadius: 16,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#0b5cff",
    color: "#fff",
    fontWeight: 900,
    letterSpacing: 0.5,
  },
  title: { margin: 0, fontSize: 22, fontWeight: 900 },
  subtitle: { margin: "6px 0 0", color: "#5b677a", fontSize: 13 },

  deployBadge: {
    marginTop: 8,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid #dbe9ff",
    background: "#eef5ff",
    color: "#0b5cff",
    fontSize: 12,
    fontWeight: 900,
    width: "fit-content",
  },

  form: { display: "flex", flexDirection: "column", gap: 12, marginTop: 10 },
  label: { display: "flex", flexDirection: "column", gap: 6, fontSize: 13 },
  miniHint: { color: "#6b7280", fontSize: 12 },
  input: {
    height: 44,
    borderRadius: 12,
    border: "1px solid #dbe3ef",
    padding: "0 12px",
    fontSize: 14,
    outline: "none",
  },
  textarea: {
    minHeight: 90,
    borderRadius: 12,
    border: "1px solid #dbe3ef",
    padding: 12,
    fontSize: 14,
    outline: "none",
    resize: "vertical",
  },
  select: {
    height: 44,
    borderRadius: 12,
    border: "1px solid #dbe3ef",
    padding: "0 12px",
    fontSize: 14,
    outline: "none",
    background: "#fff",
  },
  button: {
    height: 44,
    borderRadius: 12,
    border: "none",
    background: "#0b5cff",
    color: "#fff",
    fontWeight: 800,
    fontSize: 14,
    cursor: "pointer",
    marginTop: 4,
  },
  secondaryBtn: {
    height: 44,
    borderRadius: 12,
    border: "1px solid #dbe3ef",
    background: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    padding: "0 14px",
    width: "fit-content",
  },
  primaryBtn: {
    height: 44,
    borderRadius: 12,
    border: "none",
    background: "#0b5cff",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    padding: "0 14px",
    width: "fit-content",
  },
  errorBox: {
    border: "1px solid #ffd6d6",
    background: "#fff5f5",
    color: "#b42318",
    borderRadius: 12,
    padding: "10px 12px",
    fontSize: 13,
    lineHeight: 1.6,
  },
  infoBox: {
    border: "1px solid #dbe9ff",
    background: "#f5f9ff",
    color: "#0b5cff",
    borderRadius: 12,
    padding: "10px 12px",
    fontSize: 13,
    lineHeight: 1.6,
    marginTop: 8,
  },
  demoBox: {
    marginTop: 2,
    border: "1px dashed #dbe3ef",
    background: "#fbfdff",
    borderRadius: 14,
    padding: 12,
  },
  demoTitle: { fontWeight: 900, marginBottom: 8, fontSize: 13 },
  demoRow: { display: "flex", gap: 10, alignItems: "center", marginTop: 6 },
  badge: {
    fontSize: 11,
    fontWeight: 900,
    background: "#eef5ff",
    color: "#0b5cff",
    borderRadius: 999,
    padding: "4px 10px",
    border: "1px solid #dbe9ff",
    minWidth: 92,
    textAlign: "center",
  },
  demoText: { fontSize: 13, color: "#1f2a37" },
  shell: {
    width: "min(1100px, 100%)",
    background: "#ffffff",
    border: "1px solid #eef2f7",
    borderRadius: 18,
    boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
    overflow: "hidden",
  },
  topbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 18px",
    borderBottom: "1px solid #eef2f7",
    gap: 10,
    flexWrap: "wrap",
  },
  brand: { display: "flex", gap: 12, alignItems: "center" },
  logoSm: {
    width: 44,
    height: 44,
    borderRadius: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#0b5cff",
    color: "#fff",
    fontWeight: 900,
    letterSpacing: 0.5,
  },
  brandTitle: { fontWeight: 900, fontSize: 16 },
  brandSub: { color: "#6b7280", fontSize: 12, marginTop: 2 },
  ghostBtn: {
    height: 40,
    padding: "0 12px",
    borderRadius: 12,
    border: "1px solid #dbe3ef",
    background: "#fff",
    cursor: "pointer",
    fontWeight: 800,
    whiteSpace: "nowrap",
  },
  main: { padding: 18 },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: 12,
  },
  cardBox: {
    border: "1px solid #eef2f7",
    borderRadius: 16,
    padding: 14,
    background: "#fff",
  },
  cardTitle: { fontWeight: 900, marginBottom: 6 },
  cardDesc: {
    color: "#6b7280",
    fontSize: 13,
    lineHeight: 1.6,
    minHeight: 44,
  },
  cardBtn: {
    marginTop: 10,
    height: 40,
    borderRadius: 12,
    border: "none",
    background: "#0b5cff",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    width: "100%",
  },
  noteBox: {
    marginTop: 14,
    border: "1px dashed #dbe3ef",
    borderRadius: 16,
    padding: 14,
    background: "#fbfdff",
  },
  noteTitle: { fontWeight: 900, marginBottom: 6 },
  noteText: { color: "#5b677a", fontSize: 13, lineHeight: 1.7 },
  note: { marginTop: 12, color: "#6b7280", fontSize: 12, lineHeight: 1.7 },
  topRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  h2: { fontWeight: 900, fontSize: 18 },
  sub2: { color: "#5b677a", fontSize: 13, marginTop: 4 },
  videoWrap: {
    border: "1px solid #eef2f7",
    borderRadius: 16,
    overflow: "hidden",
    background: "#000",
    marginTop: 10,
  },
  video: { width: "100%", height: "auto", display: "block" },
  actionsRow: { display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" },
  twoCols: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 12,
    alignItems: "start",
  },
  twoMiniCols: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    alignItems: "start",
  },
  panel: {
    border: "1px solid #eef2f7",
    borderRadius: 16,
    padding: 14,
    background: "#fff",
  },
  panelTitle: { fontWeight: 900, marginBottom: 10 },
  kv: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    border: "1px solid #eef2f7",
    borderRadius: 12,
    padding: "10px 12px",
    marginTop: 10,
    alignItems: "center",
  },
  k: { color: "#1f2a37" },
  v: { color: "#111827", fontWeight: 900, textAlign: "right" },
  tag: {
    fontSize: 11,
    fontWeight: 900,
    background: "#eef5ff",
    color: "#0b5cff",
    borderRadius: 999,
    padding: "4px 10px",
    border: "1px solid #dbe9ff",
    whiteSpace: "nowrap",
  },
  studentRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    padding: "10px 12px",
    border: "1px solid #eef2f7",
    borderRadius: 14,
    marginTop: 10,
    alignItems: "center",
  },
  noteItem: {
    border: "1px solid #eef2f7",
    borderRadius: 14,
    padding: "10px 12px",
    marginTop: 10,
    background: "#fff",
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    zIndex: 999,
  },
  modal: {
    width: "min(520px, 100%)",
    background: "#fff",
    borderRadius: 18,
    border: "1px solid #eef2f7",
    padding: 16,
    boxShadow: "0 15px 40px rgba(0,0,0,0.18)",
  },
};