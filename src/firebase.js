import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyD08TGqJAM5AZ9Zd_tk8re8xrGzDtBh2x4",
  authDomain: "student360-5040e.firebaseapp.com",
  projectId: "student360-5040e",
  storageBucket: "student360-5040e.firebasestorage.app",
  messagingSenderId: "150120486823",
  appId: "1:150120486823:web:16ebecb5104b1f068c0882",
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);