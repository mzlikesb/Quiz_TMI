import { initializeApp } from 'firebase/app'
import { getAnalytics, isSupported } from 'firebase/analytics'

export const firebaseConfig = {
  apiKey: 'AIzaSyCZkYg5ixHpno7WOzOJtUQXyvyDB2uGryA',
  authDomain: 'quiz-tmi.firebaseapp.com',
  projectId: 'quiz-tmi',
  storageBucket: 'quiz-tmi.firebasestorage.app',
  messagingSenderId: '137545013592',
  appId: '1:137545013592:web:76849a8a782acc403b2d2d',
  measurementId: 'G-4EN3QFRZ4D',
}

export const firebaseApp = initializeApp(firebaseConfig)

export async function initAnalytics() {
  if (typeof window === 'undefined') return null
  if (!(await isSupported())) return null
  return getAnalytics(firebaseApp)
}
