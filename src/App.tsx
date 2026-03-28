/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI } from '@google/genai';
import Papa from 'papaparse';
import JSZip from 'jszip';
import { Search, Download, MapPin, Loader2, FileText, AlertCircle, Upload, X, Play, Square, Info, ListOrdered, Zap, Trash2, ChevronRight, Pause, FolderArchive, Cloud, Settings } from 'lucide-react';
import { db, auth } from './firebase';
import { doc, getDoc, setDoc, updateDoc, increment, serverTimestamp, onSnapshot } from 'firebase/firestore';
import { signInAnonymously, onAuthStateChanged } from 'firebase/auth';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string;
    email?: string | null;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    tenantId?: string | null;
    providerInfo?: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface QueuedFile {
  id: string;
  name: string;
  relativePath?: string;
  content: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  recordsFound: number;
  inputTokens: number;
  outputTokens: number;
  data: any[];
  targetCount: number;
  isInfinite: boolean;
  error?: string;
}

export default function App() {
  const [quotaStatus, setQuotaStatus] = useState<'unknown' | 'in-quota' | 'out-of-quota'>('unknown');
  const [usage, setUsage] = useState({ daily: 0, weekly: 0, monthly: 0, tokens: 0, cost: 0 });
  const [dailyLimit, setDailyLimit] = useState(1500);
  const [paidTokenLimit, setPaidTokenLimit] = useState(1000000);
  const [paidCostLimit, setPaidCostLimit] = useState(100);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [csvData, setCsvData] = useState<any[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [targetCount, setTargetCount] = useState(100);
  const [initialBalance, setInitialBalance] = useState(300);
  const [isInfinite, setIsInfinite] = useState(false);
  const [isSpeedMode, setIsSpeedMode] = useState(false);
  const [isParallel, setIsParallel] = useState(false);
  const [batchSize, setBatchSize] = useState(5);
  const [isPaused, setIsPaused] = useState(false);
  const [isAutoDownload, setIsAutoDownload] = useState(false);
  const [isFreeTier, setIsFreeTier] = useState(true);
  const [apiKeyStatus, setApiKeyStatus] = useState<'loading' | 'found' | 'missing'>('loading');
  const [keyPreview, setKeyPreview] = useState<string>('');
  const [dynamicApiKey, setDynamicApiKey] = useState<string | null>(null);
  const [keyIndex, setKeyIndex] = useState(0);
  const [recordsPerRequest, setRecordsPerRequest] = useState(200);
  const [currentCount, setCurrentCount] = useState(0);
  const [totalInputTokens, setTotalInputTokens] = useState(0);
  const [totalOutputTokens, setTotalOutputTokens] = useState(0);
  const [customDelay, setCustomDelay] = useState(12000);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<'gemini-3-flash-preview' | 'gemini-3.1-pro-preview'>('gemini-3-flash-preview');
  const lastRequestTimeRef = useRef<number>(0);
  const [showUsageModal, setShowUsageModal] = useState(false);
  const [cloudDetails, setCloudDetails] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stopRef = useRef(false);
  const pauseRef = useRef(false);

  useEffect(() => {
    const savedQueue = localStorage.getItem('data_scraper_queue');
    if (savedQueue) {
      try {
        const parsed = JSON.parse(savedQueue);
        // Reset processing status to pending on load
        const restoredQueue = parsed.map((f: QueuedFile) => f.status === 'processing' ? { ...f, status: 'pending' } : f);
        setQueue(restoredQueue);
        
        // Reconstruct csvData and headers from queue
        const allData = restoredQueue.flatMap((f: QueuedFile) => f.data || []);
        if (allData.length > 0) {
          setCsvData(allData);
          setCurrentCount(allData.length);
          // Try to find headers from the first file that has data
          const fileWithData = restoredQueue.find((f: QueuedFile) => f.data && f.data.length > 0);
          if (fileWithData && fileWithData.data.length > 0) {
            setHeaders(Object.keys(fileWithData.data[0]));
          }
        }
      } catch (e) {
        console.error('Failed to load queue from localStorage', e);
      }
    }
    
    const savedSettings = localStorage.getItem('data_scraper_settings');
    if (savedSettings) {
      try {
        const settings = JSON.parse(savedSettings);
        if (settings.dailyLimit) setDailyLimit(settings.dailyLimit);
        if (settings.isInfinite) setIsInfinite(settings.isInfinite);
        if (settings.isSpeedMode) setIsSpeedMode(settings.isSpeedMode);
        if (settings.isParallel) setIsParallel(settings.isParallel);
        if (settings.batchSize) setBatchSize(settings.batchSize);
        if (settings.isAutoDownload) setIsAutoDownload(settings.isAutoDownload);
        if (settings.isFreeTier !== undefined) setIsFreeTier(settings.isFreeTier);
        if (settings.recordsPerRequest) setRecordsPerRequest(settings.recordsPerRequest);
        if (settings.targetCount) setTargetCount(settings.targetCount);
        if (settings.customDelay) setCustomDelay(settings.customDelay);
      } catch (e) {
        console.error('Failed to load settings from localStorage', e);
      }
    }

    const savedManualKey = localStorage.getItem('manual_api_key');
    if (savedManualKey) {
      setManualApiKey(savedManualKey);
    }

    // Fetch dynamic API key from backend
    const fetchConfig = async () => {
      setApiKeyStatus('loading');
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          const data = await res.json();
          if (data.apiKey) {
            setDynamicApiKey(data.apiKey);
            setKeyPreview(data.keyPreview || '');
            setApiKeyStatus('found');
          } else {
            setApiKeyStatus('missing');
          }
        } else {
          setApiKeyStatus('missing');
        }
      } catch (err) {
        console.error('Failed to fetch config:', err);
        setApiKeyStatus('missing');
      }
    };
    fetchConfig();
    (window as any).refreshAppConfig = fetchConfig;
  }, []);

  useEffect(() => {
    localStorage.setItem('data_scraper_queue', JSON.stringify(queue));
  }, [queue]);

  useEffect(() => {
    if (dynamicApiKey) {
      setApiKeyStatus('found');
      setKeyPreview(`${dynamicApiKey.substring(0, 4)}...${dynamicApiKey.substring(dynamicApiKey.length - 4)}`);
    } else {
      setApiKeyStatus('missing');
    }
  }, [dynamicApiKey]);

  useEffect(() => {
    const settings = {
      dailyLimit,
      isInfinite,
      isSpeedMode,
      isParallel,
      batchSize,
      isAutoDownload,
      isFreeTier,
      recordsPerRequest,
      targetCount,
      customDelay
    };
    localStorage.setItem('data_scraper_settings', JSON.stringify(settings));
  }, [dailyLimit, isInfinite, isSpeedMode, isParallel, batchSize, isAutoDownload, isFreeTier, recordsPerRequest, targetCount, customDelay]);

  useEffect(() => {
    signInAnonymously(auth).catch((error) => {
      console.error("Error signing in anonymously:", error);
    });

    let unsubUsage: (() => void) | undefined;

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        const usageRef = doc(db, 'usage_stats', 'global');
        unsubUsage = onSnapshot(usageRef, (docSnap) => {
          if (docSnap.exists()) {
            const data = docSnap.data();
            setUsage({ 
              daily: data.dailyCount || 0, 
              weekly: data.weeklyCount || 0, 
              monthly: data.monthlyCount || 0,
              tokens: data.totalTokens || 0,
              cost: data.totalCost || 0
            });
          }
        }, (error) => {
          handleFirestoreError(error, OperationType.GET, 'usage_stats/global');
        });
      } else {
        if (unsubUsage) {
          unsubUsage();
          unsubUsage = undefined;
        }
      }
    });

    return () => {
      unsubscribe();
      if (unsubUsage) {
        unsubUsage();
      }
    };
  }, []);

  const incrementUsage = async (inputTokens: number, outputTokens: number) => {
    const usageRef = doc(db, 'usage_stats', 'global');
    
    // Simple cost calculation: $0.000001 per token
    const cost = (inputTokens + outputTokens) * 0.000001;
    
    try {
      await setDoc(usageRef, {
        dailyCount: increment(1),
        weeklyCount: increment(1),
        monthlyCount: increment(1),
        totalTokens: increment(inputTokens + outputTokens),
        totalCost: increment(cost)
      }, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'usage_stats/global');
    }
    
    setUsage(prev => ({ 
      ...prev, 
      daily: prev.daily + 1, 
      weekly: prev.weekly + 1, 
      monthly: prev.monthly + 1,
      tokens: prev.tokens + inputTokens + outputTokens,
      cost: prev.cost + cost
    }));
  };

  const fetchCloudDetails = async () => {
    try {
      const docRef = doc(db, 'usage_stats', 'global');
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        setCloudDetails(docSnap.data());
      } else {
        setCloudDetails({ message: 'No usage data found in cloud yet.' });
      }
      setShowUsageModal(true);
    } catch (error) {
      console.error("Error fetching cloud details:", error);
      setCloudDetails({ error: 'Failed to fetch data from Firestore.' });
      setShowUsageModal(true);
    }
  };

  const checkPause = async () => {
    while (pauseRef.current && !stopRef.current) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  };

  const togglePause = () => {
    const nextValue = !pauseRef.current;
    pauseRef.current = nextValue;
    setIsPaused(nextValue);
  };

  const runSystemTest = async () => {
    console.log('Starting System Test...');
    setError('Running system test...');
    setLoading(true);
    try {
      const apiKey = manualApiKey || dynamicApiKey || process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || (window as any).GEMINI_API_KEY;
      if (!apiKey) throw new Error('API Key missing. Please set GEMINI_API_KEY in settings or enter it manually.');
      const ai = new GoogleGenAI({ apiKey });
      
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: 'Return a simple CSV with one row: "Test,Success"',
      });
      console.log('Test Result:', response.text);
      setError('System Test Success: ' + response.text?.trim());
      setQuotaStatus('in-quota');
    } catch (err: any) {
      console.error('System Test Failed:', err);
      let errorMessage = 'System Test Failed: ' + (err.message || 'Unknown error');
      if (err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED')) {
        errorMessage = 'System Test Failed: Quota exceeded. Please check your billing plan or wait a while before trying again.';
        setQuotaStatus('out-of-quota');
      } else if (err.message?.includes('502')) {
        errorMessage = 'System Test Failed: Server error (502 Bad Gateway). Please try again in a moment.';
      }
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as any[];
    if (files.length === 0) return;

    const validFiles = files.filter(f => f.name.endsWith('.md') || f.name.endsWith('.txt'));
    if (validFiles.length === 0) {
      setError('Please upload .md or .txt files.');
      return;
    }

    setLoading(true);
    const filePromises = validFiles.map(file => {
      return new Promise<QueuedFile>((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          resolve({
            id: Math.random().toString(36).substr(2, 9),
            name: file.name,
            relativePath: file.webkitRelativePath || file.name,
            content: event.target?.result as string,
            status: 'pending',
            recordsFound: 0,
            inputTokens: 0,
            outputTokens: 0,
            data: [],
            targetCount: targetCount,
            isInfinite: isInfinite
          });
        };
        reader.readAsText(file);
      });
    });

    const newFiles = await Promise.all(filePromises);
    setQueue(prev => [...prev, ...newFiles]);
    setLoading(false);
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFromQueue = (id: string) => {
    setQueue(prev => prev.filter(f => f.id !== id));
    if (activeFileId === id) handleStop();
  };

  const clearQueue = () => {
    setQueue([]);
    setCsvData([]);
    setHeaders([]);
    setCurrentCount(0);
    handleStop();
  };

  const handleStop = () => {
    setIsStopping(true);
    stopRef.current = true;
  };

  const downloadFileResults = (file: QueuedFile) => {
    if (file.data.length === 0) return;
    const csv = Papa.unparse(file.data);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    const fileName = file.name.replace(/\.(md|txt)$/i, '') + '.csv';
    link.setAttribute('href', url);
    link.setAttribute('download', fileName);
    link.click();
  };

  const updateFileTargetCount = (id: string, count: number) => {
    setQueue(prev => prev.map(f => f.id === id ? { ...f, targetCount: Math.max(1, count) } : f));
  };

  const toggleFileInfinite = (id: string) => {
    setQueue(prev => prev.map(f => f.id === id ? { ...f, isInfinite: !f.isInfinite } : f));
  };

  const cleanCsvData = (data: any[], headers: string[]) => {
    return data
      .filter(row => Object.values(row).some(val => val !== null && val !== undefined && val !== ''))
      .map(row => {
        const cleanedRow: any = {};
        headers.forEach(header => {
          cleanedRow[header] = row[header] ? row[header].toString().trim() : 'N/A';
        });
        return cleanedRow;
      });
  };

  const processFile = async (file: QueuedFile, ai: any) => {
    console.log('Processing file:', file.name, 'ID:', file.id);
    setActiveFileId(file.id);
    setQueue(prev => prev.map(f => f.id === file.id ? { ...f, status: 'processing' } : f));
    
    let fileData: any[] = [...(file.data || [])];
    let fileInputTokens = file.inputTokens || 0;
    let fileOutputTokens = file.outputTokens || 0;
    let iteration = 0;
    const fileTarget = file.targetCount;
    const fileIsInfinite = file.isInfinite;
    const maxIterations = fileIsInfinite ? 500 : Math.ceil(fileTarget / recordsPerRequest) + 2;

    while ((fileIsInfinite || fileData.length < fileTarget) && !stopRef.current && iteration < maxIterations) {
      if (usage.daily >= dailyLimit) {
        setError(`Daily limit of ${dailyLimit} requests reached.`);
        handleStop();
        break;
      }
      await checkPause();
      
      const lastNames = fileData.slice(-10).map(d => d.Name || d.name || Object.values(d)[0]).join(', ');
      
      const iterationPrompt = `You are a database administrator. Your task is to scrape data and output it in a strictly formatted, clean, database-ready CSV format.
Instructions: ${file.content}

Requirements:
1. No empty rows.
2. Consistent column count for every row.
3. If a value is missing, use 'N/A'.
4. Normalize data types (e.g., dates as YYYY-MM-DD, numbers as integers/floats).
5. Output your response STRICTLY as a valid CSV format.
6. NO conversational filler.
7. NO markdown formatting.
8. The first row MUST be the headers.`;

      try {
        // Global Rate Limiter to prevent hitting quota even with multiple files
        const now = Date.now();
        const minInterval = isFreeTier ? 12000 : 1000;
        const timeSinceLast = now - lastRequestTimeRef.current;
        if (timeSinceLast < minInterval) {
          await new Promise(resolve => setTimeout(resolve, minInterval - timeSinceLast));
        }
        lastRequestTimeRef.current = Date.now();

        let response;
        try {
          response = await ai.models.generateContent({
            model: selectedModel,
            contents: iterationPrompt,
            config: {
              tools: [{ googleSearch: {} }],
            },
          });
        } catch (err: any) {
          if (err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED')) {
            console.warn('Quota exceeded, rotating key...');
            setKeyIndex(prev => prev + 1);
            // Retry with new key
            const allKeys = [
              ...(dynamicApiKey ? [dynamicApiKey] : []),
              process.env.GEMINI_API_KEY,
              process.env.VITE_GEMINI_API_KEY,
              ...backupApiKeys
            ].filter(Boolean) as string[];
            const newApiKey = allKeys[(keyIndex + 1) % allKeys.length];
            const newAi = new GoogleGenAI({ apiKey: newApiKey });
            response = await newAi.models.generateContent({
              model: selectedModel,
              contents: iterationPrompt,
              config: {
                tools: [{ googleSearch: {} }],
              },
            });
          } else {
            throw err;
          }
        }

        // Track tokens
        const promptTokens = response.usageMetadata?.promptTokenCount || 0;
        const candidateTokens = response.usageMetadata?.candidatesTokenCount || 0;
        
        await incrementUsage(promptTokens, candidateTokens);

        fileInputTokens += promptTokens;
        fileOutputTokens += candidateTokens;
        setTotalInputTokens(prev => prev + promptTokens);
        setTotalOutputTokens(prev => prev + candidateTokens);

        const text = response.text?.trim() || '';
        let csvContent = text;
        const markdownMatch = text.match(/```(?:csv)?\n([\s\S]*?)\n```/i);
        if (markdownMatch && markdownMatch[1]) {
          csvContent = markdownMatch[1].trim();
        } else {
          const lines = text.split('\n');
          const firstHeaderIndex = lines.findIndex(line => line.includes(',') && line.split(',').length > 2);
          if (firstHeaderIndex !== -1) {
            csvContent = lines.slice(firstHeaderIndex).join('\n').trim();
          }
        }

        const parsed = Papa.parse(csvContent, {
          header: true,
          skipEmptyLines: 'greedy',
          dynamicTyping: true,
        });

        const sanitizeRecord = (record: any) => {
          const cleaned: any = {};
          for (const key in record) {
            let val = record[key];
            if (typeof val === 'string') val = val.trim();
            
            if (val !== null && val !== undefined && val !== '' && val !== 'N/A' && val !== 'null' && val !== 'undefined' && val !== 'unknown') {
              cleaned[key] = val;
            }
          }
          return cleaned;
        };

        if (parsed.data && parsed.data.length > 0) {
          const newRecords = parsed.data
            .map(sanitizeRecord)
            .filter((row: any) => {
              const name = row.Name || row.name || Object.values(row)[0];
              if (!name) return false;
              return !fileData.some(existing => {
                const existingName = existing.Name || existing.name || Object.values(existing)[0];
                return String(name).toLowerCase() === String(existingName).toLowerCase();
              });
            });

          if (newRecords.length === 0) {
            if (iteration > 10) break;
          }

          // Strictly adhere to targetCount if not in infinite mode
          const remainingNeeded = fileIsInfinite ? newRecords.length : fileTarget - fileData.length;
          const recordsToAdd = newRecords.slice(0, Math.max(0, remainingNeeded));
          
          if (recordsToAdd.length === 0 && !fileIsInfinite) break;

          fileData = [...fileData, ...recordsToAdd];
          setCsvData(prev => [...prev, ...recordsToAdd]);
          setCurrentCount(prev => prev + recordsToAdd.length);
          setQueue(prev => prev.map(f => f.id === file.id ? { 
            ...f, 
            recordsFound: fileData.length, 
            inputTokens: fileInputTokens,
            outputTokens: fileOutputTokens,
            data: fileData 
          } : f));
          
          if (fileData.length >= fileTarget && !fileIsInfinite) break;
          
          if (parsed.meta.fields && headers.length === 0) {
            setHeaders(parsed.meta.fields);
          }
        } else {
          if (iteration > 10) break;
        }

        iteration++;
        const delay = customDelay || (isFreeTier ? 12000 : (isSpeedMode ? 500 : 1500));
        await new Promise(resolve => setTimeout(resolve, delay));
      } catch (err: any) {
        console.error('Iteration error:', err);
        const isQuotaError = err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED') || err.message?.includes('Quota exceeded') || err.message?.includes('rate limit');
        
        if (isQuotaError) {
          setError('Quota exceeded (Google Free Key Limit). Waiting 90 seconds for reset... will auto-resume.');
          setQueue(prev => prev.map(f => f.id === file.id ? { ...f, status: 'processing', error: 'Quota exceeded - Waiting 90s' } : f));
          
          // Wait 90 seconds automatically for quota reset
          await new Promise(resolve => setTimeout(resolve, 90000));
          
          if (stopRef.current) break;
          setError('');
          continue; // Retry the same iteration automatically
        }

        setQueue(prev => prev.map(f => f.id === file.id ? { ...f, error: err.message || 'Unknown error', status: 'failed' } : f));
        break;
      }
    }

    const finalStatus = stopRef.current ? 'failed' : (fileData.length >= fileTarget || fileIsInfinite ? 'completed' : 'failed');
    const finalFile = { 
      ...file, 
      status: finalStatus as any, 
      recordsFound: fileData.length, 
      inputTokens: fileInputTokens,
      outputTokens: fileOutputTokens,
      data: fileData 
    };
    
    setQueue(prev => prev.map(f => f.id === file.id ? finalFile : f));
    
    if (finalStatus === 'completed' && isAutoDownload && fileData.length > 0) {
      downloadFileResults(finalFile);
    }
    
    return fileData;
  };

  const retryFile = (id: string) => {
    setQueue(prev => prev.map(f => f.id === id ? { ...f, status: 'pending', error: undefined } : f));
  };

  const handleGenerate = async () => {
    console.log('Queue state:', queue.map(f => ({ name: f.name, status: f.status })));
    
    // Include files that are 'pending', 'processing' (stuck), 'failed', 
    // OR 'completed' but haven't reached target count
    const filesToProcess = queue.filter(f => 
      f.status === 'pending' || 
      f.status === 'processing' ||
      f.status === 'failed' ||
      (f.status === 'completed' && (f.isInfinite || (f.data?.length || 0) < f.targetCount))
    );

    console.log('Files to process:', filesToProcess.length, filesToProcess.map(f => f.name));

    if (filesToProcess.length === 0) {
      setError('No files in queue needing processing.');
      return;
    }

    // Reset status of files to be processed to 'pending'
    setQueue(prev => prev.map(f => 
      filesToProcess.some(ftp => ftp.id === f.id) 
        ? { ...f, status: 'pending', error: undefined } 
        : f
    ));

    setLoading(true);
    setIsStopping(false);
    setIsPaused(false);
    stopRef.current = false;
    pauseRef.current = false;
    setError('');
    // Note: We don't clear csvData/headers here to allow appending
    // setCsvData([]); 
    // setHeaders([]);
    setCurrentCount(0);

    if (isParallel && isFreeTier) {
      setError('Warning: Parallel processing with Free Tier often causes Quota errors. Consider turning off Parallel or using a Paid key.');
    }

    try {
      const allKeys = [
        ...(dynamicApiKey ? [dynamicApiKey] : []),
        process.env.GEMINI_API_KEY,
        process.env.VITE_GEMINI_API_KEY
      ].filter(Boolean) as string[];

      if (allKeys.length === 0) {
        throw new Error('No API keys available.');
      }

      const apiKey = allKeys[keyIndex % allKeys.length];
      
      console.log('Using API Key Index:', keyIndex % allKeys.length);
      
      // ... (rest of the generation logic)
      
      // On error (e.g., 429 Quota Exceeded), increment keyIndex
      // setKeyIndex(prev => prev + 1);
      const ai = new GoogleGenAI({ apiKey });
      
      if (isParallel) {
        // Worker Pool: Maintain a constant number of active processes
        const pool = [...filesToProcess];
        const workers = Array(Math.min(batchSize, pool.length)).fill(null).map(async () => {
          while (pool.length > 0 && !stopRef.current) {
            const file = pool.shift();
            if (file) await processFile(file, ai);
          }
        });
        await Promise.all(workers);
      } else {
        // Serial processing: One by one
        for (const file of filesToProcess) {
          if (stopRef.current) break;
          await processFile(file, ai);
        }
      }

      if (stopRef.current) {
        setError('Scraping stopped by user.');
      }
    } catch (err: any) {
      if (err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED')) {
        setQuotaStatus('out-of-quota');
      }
      setError(err.message || 'An error occurred.');
    } finally {
      setLoading(false);
      setIsStopping(false);
      setActiveFileId(null);
    }
  };

  const handleDownload = () => {
    if (csvData.length === 0) return;
    const csv = Papa.unparse(csvData);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `scraped_data_${csvData.length}.csv`);
    link.click();
  };

  const handleDownloadAllZip = async () => {
    const filesWithData = queue.filter(f => f.data && f.data.length > 0);
    if (filesWithData.length === 0) return;

    setLoading(true);
    try {
      const zip = new JSZip();
      filesWithData.forEach(file => {
        const csv = Papa.unparse(file.data);
        // Use relativePath if available (it includes folder structure), otherwise just name
        const path = file.relativePath 
          ? file.relativePath.replace(/\.(md|txt)$/i, '.csv') 
          : file.name.replace(/\.(md|txt)$/i, '.csv');
        zip.file(path, csv);
      });

      const content = await zip.generateAsync({ type: 'blob' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(content);
      link.setAttribute('href', url);
      link.setAttribute('download', `scraped_data_structure_${new Date().getTime()}.zip`);
      link.click();
    } catch (err) {
      console.error('ZIP generation error:', err);
      setError('Failed to generate ZIP file.');
    } finally {
      setLoading(false);
    }
  };

  const totalWorkNeeded = queue.reduce((acc, f) => acc + (f.isInfinite ? 0 : f.targetCount), 0);
  const totalWorkCompleted = queue.reduce((acc, f) => acc + f.recordsFound, 0);
  const totalWorkRemaining = Math.max(0, totalWorkNeeded - totalWorkCompleted);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-blue-600 p-2 rounded-lg">
              <MapPin className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">GeoScraper Pro</h1>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex flex-col gap-1 w-48">
              <div className="flex justify-between text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                <span>Free Tier Usage</span>
                <span>{usage.daily} / {dailyLimit}</span>
              </div>
              <div className="h-2 w-full bg-slate-200 rounded-full overflow-hidden">
                <div 
                  className={`h-full transition-all duration-500 ${usage.daily >= dailyLimit ? 'bg-red-500' : 'bg-blue-600'}`}
                  style={{ width: `${Math.min((usage.daily / dailyLimit) * 100, 100)}%` }}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1 w-48">
              <div className="flex justify-between text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                <span>Token Usage</span>
                <span>{(usage.tokens / 1000).toFixed(1)}k / {(paidTokenLimit / 1000).toFixed(1)}k</span>
              </div>
              <div className="h-2 w-full bg-slate-200 rounded-full overflow-hidden">
                <div 
                  className={`h-full transition-all duration-500 ${usage.tokens >= paidTokenLimit ? 'bg-red-500' : 'bg-emerald-600'}`}
                  style={{ width: `${Math.min((usage.tokens / paidTokenLimit) * 100, 100)}%` }}
                />
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-4 px-4 py-2 bg-slate-100 rounded-lg text-xs font-semibold text-slate-600">
              <span>Daily: <span className="text-blue-600">{usage.daily}</span></span>
              <span>Weekly: <span className="text-blue-600">{usage.weekly}</span></span>
              <span>Monthly: <span className="text-blue-600">{usage.monthly}</span></span>
            </div>
            <button 
              onClick={fetchCloudDetails} 
              className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-lg text-xs font-bold transition-colors border border-indigo-100"
              title="Fetch latest usage details from Cloud"
            >
              <Cloud className="w-4 h-4" />
              Cloud Details
            </button>
            <div className="hidden sm:flex items-center gap-2 px-3 py-1 bg-slate-100 rounded-full border border-slate-200 relative group">
              <div className={`w-2 h-2 rounded-full ${apiKeyStatus === 'found' ? 'bg-green-500' : apiKeyStatus === 'loading' ? 'bg-yellow-500' : 'bg-red-500'}`} />
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold leading-none">
                  API KEY: {apiKeyStatus === 'found' ? 'LOADED' : apiKeyStatus === 'loading' ? 'CHECKING...' : 'MISSING'}
                </span>
                {keyPreview && <span className="text-[8px] font-mono text-slate-400 mt-0.5">{keyPreview}</span>}
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-2 px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-xs font-semibold">
              <Zap className="w-3 h-3" />
              Queue System Active
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-white p-4 rounded-lg shadow-sm border border-slate-200 mb-6 flex justify-between items-center">
          <div className="text-sm font-medium text-slate-600">
            Total Work Needed: <span className="font-bold text-blue-600">{totalWorkNeeded}</span> records
          </div>
          <div className="text-sm font-medium text-slate-600">
            Work Remaining: <span className="font-bold text-amber-600">{totalWorkRemaining}</span> records
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column: Queue & Config */}
          <div className="lg:col-span-1 space-y-6">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <ListOrdered className="w-5 h-5 text-blue-600" />
                  File Queue
                </h2>
                <div className="flex items-center gap-2">
                  {queue.some(f => 
                    f.status === 'processing' || 
                    f.status === 'failed' || 
                    (f.status === 'completed' && (f.isInfinite || (f.data?.length || 0) < f.targetCount))
                  ) && !loading && (
                    <button 
                      onClick={handleGenerate} 
                      className="text-[10px] font-bold text-blue-600 hover:text-blue-800 bg-blue-50 px-2 py-1 rounded border border-blue-100 flex items-center gap-1"
                      title="Resume all incomplete files"
                    >
                      <Play className="w-3 h-3" /> Resume All
                    </button>
                  )}
                  {queue.length > 0 && (
                    <button onClick={clearQueue} className="text-slate-400 hover:text-red-500 transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
              
              <div className="space-y-4">
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 mb-4">
                  <h3 className="text-[10px] font-bold text-slate-500 uppercase mb-2">Live Balance Tracker</h3>
                  <div className="flex justify-between items-end">
                    <div>
                      <div className="text-2xl font-mono font-bold text-green-600">${Math.max(0, initialBalance - usage.cost).toFixed(4)}</div>
                      <div className="text-[10px] text-slate-400">Remaining</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-mono font-bold text-slate-600">${usage.cost.toFixed(4)}</div>
                      <div className="text-[10px] text-slate-400">Spent</div>
                    </div>
                  </div>
                  <div className="w-full bg-slate-200 h-2 rounded-full mt-3 overflow-hidden">
                     <div className="bg-green-500 h-full transition-all duration-500" style={{width: `${Math.max(0, Math.min(100, ((initialBalance - usage.cost) / initialBalance) * 100))}%`}} />
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Daily Request Limit</label>
                    <input 
                      type="number" 
                      value={dailyLimit}
                      onChange={(e) => setDailyLimit(Math.max(1, parseInt(e.target.value) || 0))}
                      className="w-full p-2 border border-slate-300 rounded-lg text-sm disabled:opacity-50"
                      disabled={loading}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Token Limit</label>
                    <input 
                      type="number" 
                      value={paidTokenLimit}
                      onChange={(e) => setPaidTokenLimit(Math.max(1, parseInt(e.target.value) || 0))}
                      className="w-full p-2 border border-slate-300 rounded-lg text-sm disabled:opacity-50"
                      disabled={loading}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Target</label>
                    <input 
                      type="number" 
                      value={targetCount}
                      onChange={(e) => setTargetCount(Math.max(1, parseInt(e.target.value) || 0))}
                      className="w-full p-2 border border-slate-300 rounded-lg text-sm disabled:opacity-50"
                      disabled={loading || isInfinite}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Records Per Request</label>
                    <input 
                      type="number" 
                      value={recordsPerRequest}
                      onChange={(e) => setRecordsPerRequest(Math.max(1, parseInt(e.target.value) || 0))}
                      className="w-full p-2 border border-slate-300 rounded-lg text-sm disabled:opacity-50"
                      disabled={loading}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Delay (ms)</label>
                    <input 
                      type="number" 
                      value={customDelay}
                      onChange={(e) => setCustomDelay(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-full p-2 border border-slate-300 rounded-lg text-sm disabled:opacity-50"
                      placeholder="e.g. 6500"
                      disabled={loading}
                    />
                  </div>
                  <div className="flex items-end">
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Model</label>
                    <select 
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value as any)}
                      className="w-full p-2 border border-slate-300 rounded-lg text-sm disabled:opacity-50"
                      disabled={loading}
                    >
                      <option value="gemini-3-flash-preview">Gemini 3 Flash</option>
                      <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
                      <input 
                        type="checkbox" 
                        checked={isInfinite}
                        onChange={(e) => setIsInfinite(e.target.checked)}
                        className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm font-medium text-slate-700">Infinite Mode</span>
                    </label>
                  </div>
                </div>

                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                  <div className="flex items-center gap-2">
                    <Download className={`w-4 h-4 ${isAutoDownload ? 'text-blue-600' : 'text-slate-400'}`} />
                    <span className="text-sm font-medium">Auto-Download</span>
                  </div>
                  <button 
                    onClick={() => setIsAutoDownload(!isAutoDownload)}
                    className={`w-10 h-5 rounded-full transition-colors relative ${isAutoDownload ? 'bg-blue-600' : 'bg-slate-300'}`}
                  >
                    <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${isAutoDownload ? 'left-6' : 'left-1'}`} />
                  </button>
                </div>

                <div className="flex flex-col gap-2 p-3 bg-slate-50 rounded-lg border border-slate-100">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ListOrdered className={`w-4 h-4 ${isParallel ? 'text-blue-600' : 'text-slate-400'}`} />
                      <span className="text-sm font-medium">Parallel Mode</span>
                    </div>
                    <button 
                      onClick={() => setIsParallel(!isParallel)}
                      className={`w-10 h-5 rounded-full transition-colors relative ${isParallel ? 'bg-blue-600' : 'bg-slate-300'}`}
                    >
                      <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${isParallel ? 'left-6' : 'left-1'}`} />
                    </button>
                  </div>
                  {isParallel && (
                    <div className="mt-2 pt-2 border-t border-slate-200">
                      <div className="flex justify-between items-center mb-1">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">Batch Size (Concurrent)</label>
                        <span className="text-xs font-bold text-blue-600">{batchSize}</span>
                      </div>
                      <input 
                        type="range" 
                        min="1" 
                        max="20" 
                        value={batchSize}
                        onChange={(e) => setBatchSize(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                      />
                      <p className="text-[9px] text-slate-400 mt-1">Number of files processed simultaneously.</p>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                  <div className="flex items-center gap-2">
                    <Cloud className={`w-4 h-4 ${isFreeTier ? 'text-blue-600' : 'text-slate-400'}`} />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">Free Tier (Safe Mode)</span>
                      <span className="text-[9px] text-slate-500">Slower requests to avoid Quota errors</span>
                    </div>
                  </div>
                  <button 
                    onClick={() => setIsFreeTier(!isFreeTier)}
                    className={`w-10 h-5 rounded-full transition-colors relative ${isFreeTier ? 'bg-blue-600' : 'bg-slate-300'}`}
                  >
                    <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${isFreeTier ? 'left-6' : 'left-1'}`} />
                  </button>
                </div>

                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                  <div className="flex items-center gap-2">
                    <Zap className={`w-4 h-4 ${isSpeedMode && !isFreeTier ? 'text-amber-500' : 'text-slate-400'}`} />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">Speed Optimization</span>
                      <span className="text-[9px] text-slate-500">Faster processing (Paid keys only)</span>
                    </div>
                  </div>
                  <button 
                    onClick={() => setIsSpeedMode(!isSpeedMode)}
                    disabled={isFreeTier}
                    className={`w-10 h-5 rounded-full transition-colors relative ${isSpeedMode && !isFreeTier ? 'bg-blue-600' : 'bg-slate-300'} ${isFreeTier ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${isSpeedMode && !isFreeTier ? 'left-6' : 'left-1'}`} />
                  </button>
                </div>

                <label className="flex flex-col items-center justify-center w-full h-24 border-2 border-dashed border-slate-300 rounded-lg cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors relative">
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    <Upload className="w-6 h-6 mb-2 text-slate-400" />
                    <p className="text-xs text-slate-500 font-medium text-center px-2">Click to select files or a folder</p>
                  </div>
                  <input 
                    type="file" 
                    className="absolute inset-0 opacity-0 cursor-pointer" 
                    accept=".md,.txt" 
                    multiple 
                    onChange={handleFileUpload} 
                    ref={fileInputRef} 
                    disabled={loading}
                    {...({ webkitdirectory: "", directory: "" } as any)}
                  />
                </label>

                <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
                  {queue.map((file) => (
                    <div key={file.id} className={`p-3 rounded-lg border flex flex-col gap-2 ${activeFileId === file.id ? 'border-blue-500 bg-blue-50' : 'border-slate-100 bg-white'}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 min-w-0">
                          {file.status === 'processing' ? <Loader2 className="w-4 h-4 animate-spin text-blue-600" /> : <FileText className="w-4 h-4 text-slate-400" />}
                          <div className="min-w-0">
                            <p className="text-xs font-bold truncate">{file.name}</p>
                            <p className="text-[10px] text-slate-500">
                              {file.recordsFound} / {file.isInfinite ? '∞' : file.targetCount} records • {file.status}
                              {file.inputTokens > 0 && ` • ${Math.round((file.inputTokens + file.outputTokens) / 100) / 10}k tokens`}
                            </p>
                            {file.error && (
                              <p className="text-[9px] text-red-500 font-medium mt-0.5 max-w-full truncate" title={file.error}>
                                Error: {file.error}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {file.status === 'failed' && (
                            <button 
                              onClick={() => retryFile(file.id)}
                              className="text-amber-600 hover:text-amber-800 p-1"
                              title="Retry this file"
                            >
                              <Play className="w-4 h-4" />
                            </button>
                          )}
                          {file.data.length > 0 && (
                            <button 
                              onClick={() => downloadFileResults(file)}
                              className="text-blue-600 hover:text-blue-800 p-1"
                              title={file.status === 'completed' ? "Download this file's CSV" : "Download partial results"}
                            >
                              <Download className="w-4 h-4" />
                            </button>
                          )}
                          <button onClick={() => removeFromQueue(file.id)} className="text-slate-300 hover:text-red-500 p-1">
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      
                      {file.status === 'pending' && (
                        <div className="flex items-center gap-4 pl-7">
                          <div className="flex items-center gap-2">
                            <label className="text-[9px] font-bold text-slate-400 uppercase">Limit:</label>
                            <input 
                              type="number" 
                              value={file.targetCount}
                              onChange={(e) => updateFileTargetCount(file.id, parseInt(e.target.value) || 0)}
                              className="w-16 p-1 border border-slate-200 rounded text-[10px] focus:ring-1 focus:ring-blue-500 outline-none disabled:opacity-50"
                              disabled={loading || file.isInfinite}
                            />
                          </div>
                          <label className="flex items-center gap-1.5 cursor-pointer select-none">
                            <input 
                              type="checkbox" 
                              checked={file.isInfinite}
                              onChange={() => toggleFileInfinite(file.id)}
                              className="w-3 h-3 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                              disabled={loading}
                            />
                            <span className="text-[10px] font-medium text-slate-500">Infinite</span>
                          </label>
                        </div>
                      )}
                    </div>
                  ))}
                  {queue.length === 0 && <p className="text-center text-xs text-slate-400 py-4">Queue is empty</p>}
                </div>
              </div>

              {error && <div className="mt-4 p-3 bg-red-50 text-red-700 rounded-lg text-xs flex items-start gap-2"><AlertCircle className="w-4 h-4 shrink-0" /><p>{error}</p></div>}

              <div className="flex gap-2 mt-6">
                <button
                  type="button"
                  onClick={runSystemTest}
                  disabled={loading}
                  className="bg-slate-800 hover:bg-slate-900 text-white font-medium py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50 text-xs"
                >
                  <Zap className="w-4 h-4" /> Run System Test
                </button>
                {!loading ? (
                  <div className="flex-1 flex gap-2">
                    <button 
                      type="button"
                      onClick={(e) => { e.preventDefault(); handleGenerate(); }}
                      disabled={queue.length === 0}
                      className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      <Play className="w-4 h-4" /> {queue.some(f => 
                        f.status === 'processing' || 
                        f.status === 'failed' || 
                        (f.status === 'completed' && (f.isInfinite || (f.data?.length || 0) < f.targetCount))
                      ) ? 'Resume Incomplete' : 'Start Queue'}
                    </button>
                  </div>
                ) : (
                  <>
                    <button 
                      onClick={togglePause} 
                      className="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-medium py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
                    >
                      {isPaused ? (
                        <><Play className="w-4 h-4" /> Resume</>
                      ) : (
                        <><Pause className="w-4 h-4" /> Hold</>
                      )}
                    </button>
                    <button 
                      onClick={handleStop} 
                      disabled={isStopping} 
                      className="flex-1 bg-red-600 hover:bg-red-700 text-white font-medium py-2.5 px-4 rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {isStopping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />} Stop All
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Results */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 h-full flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <div className="flex flex-col">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <FileText className="w-5 h-5 text-blue-600" /> Live Data Stream
                  </h2>
                  {loading && <div className="flex items-center gap-2 mt-1"><div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" /><span className="text-xs text-slate-500 font-medium">Processing Queue...</span></div>}
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right border-r border-slate-200 pr-3">
                    <div className="text-[10px] text-slate-400 uppercase font-bold tracking-wider">Tokens (In/Out)</div>
                    <div className="text-xs font-mono font-bold text-slate-600">
                      {Math.round(totalInputTokens / 100) / 10}k / {Math.round(totalOutputTokens / 100) / 10}k
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-slate-400 uppercase font-bold tracking-wider">Total Found</div>
                    <div className="text-sm font-mono font-bold text-blue-600">
                      {currentCount} 
                      {queue.some(f => f.isInfinite) ? '' : ` / ${queue.reduce((acc, f) => acc + f.targetCount, 0)}`}
                    </div>
                  </div>
                  {csvData.length > 0 && (
                    <div className="flex items-center gap-2">
                      <button 
                        onClick={clearQueue}
                        className="flex items-center gap-2 text-sm font-medium text-red-600 hover:text-red-800 bg-red-50 px-3 py-1.5 rounded-md border border-red-100"
                        title="Clear all data and queue"
                      >
                        <Trash2 className="w-4 h-4" /> Clear All
                      </button>
                      <button 
                        onClick={handleDownloadAllZip} 
                        className="flex items-center gap-2 text-sm font-medium text-amber-600 hover:text-amber-800 bg-amber-50 px-3 py-1.5 rounded-md border border-amber-100"
                        title="Download all results preserving folder structure (ZIP)"
                      >
                        <FolderArchive className="w-4 h-4" /> ZIP Structure
                      </button>
                      <button onClick={handleDownload} className="flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-800 bg-blue-50 px-3 py-1.5 rounded-md border border-blue-100">
                        <Download className="w-4 h-4" /> Download All
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex-1 border border-slate-200 rounded-lg overflow-hidden bg-slate-50 relative">
                {csvData.length > 0 ? (
                  <div className="overflow-x-auto h-full max-h-[600px]">
                    <table className="w-full text-sm text-left">
                      <thead className="text-xs text-slate-700 uppercase bg-slate-100 sticky top-0 z-[5]">
                        <tr>
                          <th className="px-4 py-3 w-10">#</th>
                          {headers.map((h, i) => <th key={i} className="px-4 py-3 whitespace-nowrap">{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {csvData.map((row, i) => (
                          <tr key={i} className="bg-white border-b border-slate-100 hover:bg-slate-50">
                            <td className="px-4 py-3 text-slate-400 font-mono text-xs">{i + 1}</td>
                            {headers.map((h, j) => <td key={j} className="px-4 py-3 max-w-xs truncate" title={row[h]}>{row[h]}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="h-full min-h-[400px] flex flex-col items-center justify-center text-slate-400">
                    <MapPin className="w-12 h-12 mb-4 text-slate-300" />
                    <p>Queue is ready.</p>
                    <p className="text-xs mt-2 text-slate-500">Upload multiple files and start the process.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {showUsageModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold flex items-center gap-2 text-slate-800">
                <Cloud className="w-5 h-5 text-indigo-600" />
                Cloud Usage Details
              </h3>
              <button onClick={() => setShowUsageModal(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3">
              {cloudDetails?.error || cloudDetails?.message ? (
                <p className="text-sm text-slate-600">{cloudDetails.error || cloudDetails.message}</p>
              ) : (
                <>
                  <div className="flex justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                    <span className="text-sm font-medium text-slate-600">Total Tokens</span>
                    <span className="text-sm font-bold text-indigo-600">{cloudDetails?.totalTokens?.toLocaleString() || 0}</span>
                  </div>
                  <div className="flex justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                    <span className="text-sm font-medium text-slate-600">Total Cost (Est.)</span>
                    <span className="text-sm font-bold text-emerald-600">${cloudDetails?.totalCost?.toFixed(4) || 0}</span>
                  </div>
                  <div className="flex justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                    <span className="text-sm font-medium text-slate-600">Daily Requests</span>
                    <span className="text-sm font-bold text-blue-600">{cloudDetails?.dailyCount?.toLocaleString() || 0}</span>
                  </div>
                  <div className="flex justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                    <span className="text-sm font-medium text-slate-600">Weekly Requests</span>
                    <span className="text-sm font-bold text-blue-600">{cloudDetails?.weeklyCount?.toLocaleString() || 0}</span>
                  </div>
                  <div className="flex justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                    <span className="text-sm font-medium text-slate-600">Monthly Requests</span>
                    <span className="text-sm font-bold text-blue-600">{cloudDetails?.monthlyCount?.toLocaleString() || 0}</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-4 text-center">
                    Data fetched directly from Firestore (Cloud Database).
                  </p>
                </>
              )}
            </div>
            <div className="mt-6 flex justify-end">
              <button onClick={() => setShowUsageModal(false)} className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium hover:bg-slate-900">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
