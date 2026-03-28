import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';

export type UserRole = 'auditor' | 'manager' | 'admin' | null;

export interface UserProfile {
  uid: string;
  tenantId: string;
  name: string;
  email: string;
  role: UserRole;
  assignedProjects: string[];
  assignedSites: string[];
  status: 'active' | 'inactive';
}

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  signIn: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        try {
          const docRef = doc(db, 'users', firebaseUser.uid);
          const docSnap = await getDoc(docRef);
          
          if (docSnap.exists()) {
            setProfile({ uid: firebaseUser.uid, ...docSnap.data() } as UserProfile);
          } else {
            const isFirstUser = firebaseUser.email === 'mo.abassit.z@gmail.com';
            
            const newProfile: Omit<UserProfile, 'uid'> = {
              tenantId: 'default-tenant',
              name: firebaseUser.displayName || 'Unknown User',
              email: firebaseUser.email || '',
              role: isFirstUser ? 'admin' : 'auditor',
              assignedProjects: [],
              assignedSites: [],
              status: 'active'
            };
            
            await setDoc(docRef, newProfile);
            setProfile({ uid: firebaseUser.uid, ...newProfile } as UserProfile);
          }
        } catch (error) {
          console.error("Error fetching user profile:", error);
          // If permission denied, they might not have a profile yet or rules are strict.
        }
      } else {
        setProfile(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const signIn = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Error signing in", error);
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Error signing out", error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, profile, loading, signIn, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
