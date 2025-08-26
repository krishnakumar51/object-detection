import React, { useRef, useImperativeHandle, forwardRef, useEffect } from 'react';
import { Socket } from 'socket.io-client';
import { initYoloModel, runYoloModel } from './models/YoloWasm';
import type { Detection } from '../types';

interface WebRTCManagerProps {
  socket: Socket | null;
  mode: 'wasm' | 'server';
  roomId: string;
  videoRef: React.RefObject<HTMLVideoElement>;
  onMetricsUpdate: (metrics: any) => void;
  onDetectionResult?: (result: any) => void;
}

const WebRTCManager = forwardRef<any, WebRTCManagerProps>((
  {
    socket,
    mode,
    roomId,
    videoRef,
    onMetricsUpdate,
    onDetectionResult
  },
  ref
) => {
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const dataChannel = useRef<RTCDataChannel | null>(null);
  const remoteStream = useRef<MediaStream | null>(null);
  const isDetecting = useRef(false);
  const frameQueue = useRef<any[]>([]);
  const processingFrame = useRef(false);
  const metricsInterval = useRef<NodeJS.Timeout | null>(null);
  const frameCounter = useRef(0);
  const lastDetectionCount = useRef(0);
  const latencyHistory = useRef<number[]>([]);
  const bandwidthHistory = useRef<{timestamp: number, bytesSent: number, bytesReceived: number}[]>([]);
  const frameTimestamps = useRef<number[]>([]);

  useImperativeHandle(ref, () => ({
    startDetection: () => {
      console.log(`🎯 WebRTCManager: Starting detection in ${mode} mode`);
      isDetecting.current = true;
      startMetricsCollection();
    },
    stopDetection: () => {
      console.log('🛑 WebRTCManager: Stopping detection');
      isDetecting.current = false;
      stopMetricsCollection();
      // Clear frame queue when stopping detection
      frameQueue.current = [];
      processingFrame.current = false;
    },
    cleanup: () => {
      console.log('🧹 WebRTCManager: Performing cleanup');
      isDetecting.current = false;
      stopMetricsCollection();
      frameQueue.current = [];
      processingFrame.current = false;
    }
  }));

  // Setup WebRTC on mount
  useEffect(() => {
    setupWebRTC();

    return () => {
      cleanup();
    };
  }, []);

  // Setup socket listeners when socket becomes available
  useEffect(() => {
    if (socket) {
      console.log('🔧 Setting up socket listeners in WebRTCManager');
      setupSocketListeners();
    }
  }, [socket, roomId]);

  // Initialize YOLO model when mode is WASM
  useEffect(() => {
    if (mode === 'wasm') {
      console.log('🔄 Initializing YOLO WASM model...');
      initYoloModel()
        .then(() => {
          console.log('✅ YOLO WASM model initialized successfully');
        })
        .catch((error) => {
          console.error('❌ Failed to initialize YOLO WASM model:', error);
        });
    }
  }, [mode]);

  const setupWebRTC = () => {
    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ],
      iceCandidatePoolSize: 10 // Pre-gather ICE candidates for faster connection
    };

    peerConnection.current = new RTCPeerConnection(configuration);

    // Handle incoming stream
    peerConnection.current.ontrack = (event) => {
      console.log('Received remote track');
      remoteStream.current = event.streams[0];
      
      if (videoRef.current) {
        videoRef.current.srcObject = remoteStream.current;
      }
    };

    // Handle data channel from phone
    peerConnection.current.ondatachannel = (event) => {
      const channel = event.channel;
      if (channel.label === 'frames') {
        setupDataChannel(channel);
      }
    };

    // Create data channel for sending detection results back to phone
    dataChannel.current = peerConnection.current.createDataChannel('detections', {
      ordered: true
    });
    setupDataChannel(dataChannel.current);

    peerConnection.current.onconnectionstatechange = () => {
      const state = peerConnection.current?.connectionState;
      
      if (state === 'connected') {
        console.log('✅ WebRTC connection established');
      } else if (state === 'failed') {
        console.log('❌ WebRTC connection failed');
      }
    };

    // ICE state change handlers (minimal logging)
    peerConnection.current.onicegatheringstatechange = () => {};
    peerConnection.current.oniceconnectionstatechange = () => {};
    peerConnection.current.onsignalingstatechange = () => {};

    // Handle ICE candidates
    peerConnection.current.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('ice-candidate', {
          room: roomId,
          candidate: event.candidate
        });
      }
    };
  };

  const setupDataChannel = (channel: RTCDataChannel) => {
    
    channel.onopen = () => {
      console.log('✅ Data channel ready:', channel.label);
    };

    channel.onclose = () => {
      console.log('❌ Data channel closed:', channel.label);
    };

    channel.onerror = (error) => {
      console.error('❌ Data channel error:', channel.label, error);
    };

    channel.onmessage = async (event) => {
      try {
        const frameData = JSON.parse(event.data);
        
        // Display the frame in video element if it's a frames channel
        if (channel.label === 'frames' && frameData.imageData && videoRef.current) {
          displayFrame(frameData.imageData);
        }
        
        // Process frames for detection if detection is active
        if (isDetecting.current) {
          // Track frame arrival for accurate FPS calculation
          const now = Date.now();
          frameTimestamps.current.push(now);
          
          // Keep only last 100 frame timestamps (for memory efficiency)
          if (frameTimestamps.current.length > 100) {
            frameTimestamps.current.shift();
          }
          
          // Aggressive frame dropping for better performance
          if (processingFrame.current) {
            // Skip this frame if we're still processing the previous one
            return;
          }
          
          // Clear queue and only keep the latest frame
          frameQueue.current = [frameData];

          // Process frames immediately
          processFrameQueue();
        }
      } catch (error) {
        console.error('Error processing frame:', error);
      }
    };
  };

  const displayFrame = (base64ImageData: string) => {
    if (!videoRef.current) return;
    
    try {
      // Create or get the display canvas (cached for performance)
      let displayCanvas = videoRef.current.parentElement?.querySelector('.display-canvas') as HTMLCanvasElement;
      if (!displayCanvas) {
        displayCanvas = document.createElement('canvas');
        displayCanvas.className = 'display-canvas';
        displayCanvas.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0;';
        videoRef.current.parentElement?.appendChild(displayCanvas);
        videoRef.current.style.opacity = '';
      }
      
      // Use requestAnimationFrame for smoother rendering
      requestAnimationFrame(() => {
        const img = new Image();
        img.onload = () => {
          const ctx = displayCanvas.getContext('2d')!;
          
          // Only resize canvas if dimensions changed (performance optimization)
          const rect = displayCanvas.getBoundingClientRect();
          if (displayCanvas.width !== rect.width || displayCanvas.height !== rect.height) {
            displayCanvas.width = rect.width;
            displayCanvas.height = rect.height;
          }
          
          // Use faster rendering method
          ctx.drawImage(img, 0, 0, displayCanvas.width, displayCanvas.height);
        };
        img.src = base64ImageData;
      });
    } catch (error) {
      console.error('Error displaying frame:', error);
    }
  };

  const processFrameQueue = async () => {
    if (frameQueue.current.length === 0 || processingFrame.current) return;
    
    processingFrame.current = true;
    const frameData = frameQueue.current.shift();
    
    try {
      const result = await processFrame(frameData);
      
      // Send result back via data channel or socket (non-blocking)
      if (dataChannel.current && dataChannel.current.readyState === 'open') {
        try {
          dataChannel.current.send(JSON.stringify(result));
        } catch (sendError) {
          console.warn('Failed to send detection result:', sendError);
        }
      }
      
      frameCounter.current++;
      // Update metrics asynchronously to avoid blocking
      updateLatencyMetrics(result).catch(error => 
        console.warn('Metrics update failed:', error)
      );
      
    } catch (error) {
      console.error('Frame processing error:', error);
    } finally {
      processingFrame.current = false;
      
      // Clean up frame data to prevent memory leaks
      if (frameData && frameData.imageData) {
        frameData.imageData = null;
      }
    }
    
    // Process next frame if queue has items (optimized processing)
    if (frameQueue.current.length > 0) {
      // Use setTimeout to prevent blocking the main thread
      setTimeout(() => processFrameQueue(), 0);
    }
  };

  const processFrame = async (frameData: any): Promise<any> => {
    const { frame_id, capture_ts, imageData, width, height } = frameData;
    const recv_ts = Date.now();
    
    let detections: Detection[] = [];
    let inference_ts = recv_ts;

    // Only log when processing frames with detections (will be logged later if detections found)

    if (mode === 'wasm') {
      // Client-side inference using WASM - optimized pipeline
        const inference_start = Date.now();
        
        try {
          // Use OffscreenCanvas for better performance (if available)
          const canvas = typeof OffscreenCanvas !== 'undefined' 
            ? new OffscreenCanvas(640, 640)
            : document.createElement('canvas');
          
          if (canvas instanceof HTMLCanvasElement) {
            canvas.width = 640;
            canvas.height = 640;
          }
          
          const ctx = canvas.getContext('2d')!;
          const img = new Image();
          
          // Optimize image loading with faster decode
          await new Promise((resolve, reject) => {
            img.onload = () => resolve(null);
            img.onerror = reject;
            img.src = imageData;
          });
          
          // Use faster drawing method
          (ctx as OffscreenCanvasRenderingContext2D).drawImage(img, 0, 0, 640, 640);
          
          // Run YOLO inference with canvas
          detections = await runYoloInference(canvas as HTMLCanvasElement);
        
        // Only log when detections are found
        if (detections.length > 0) {
          console.log(`🔄 Processing frame ${frameCounter.current} in WASM mode`);
          console.log(`🎯 WASM detected: ${detections.map(d => `${d.label} (${(d.score * 100).toFixed(1)}%)`).join(', ')}`);
          lastDetectionCount.current = detections.length;
        }
        
      } catch (error) {
        console.error('❌ WASM inference error:', error);
      }
      
      inference_ts = Date.now();
      
    } else {
      // Server-side inference - resize to 640x640
      // Will log only when detections are received from server
      if (socket) {
        try {
          // Create canvas and load base64 image
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d')!;
          const img = new Image();
          
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = imageData; // base64 data URL
          });
          
          // Resize to 640x640 to match server-side YOLO model input dimensions
          canvas.width = 640;
          canvas.height = 640;
          ctx.drawImage(img, 0, 0, 640, 640);
          
          // Convert to base64 for server processing
          const resizedImageData = canvas.toDataURL('image/jpeg', 0.9);
          
          const processed = await new Promise<any>((resolve) => {
            const timeout = setTimeout(() => {
              resolve({ detections: [], inference_ts: Date.now() });
            }, 150); // Reduced timeout for faster fallback
            
            const resultHandler = (result: any) => {
              clearTimeout(timeout);
              resolve(result);
            };
            
            socket.once('detection-result', resultHandler);
            
            // Send frame for processing
            socket.emit('process-frame', {
              frame_id,
              capture_ts,
              imageData: resizedImageData,
              width: 640,
              height: 640,
              room: roomId
            });
          });
          
          detections = processed.detections;
          inference_ts = processed.inference_ts;
        } catch (error) {
          console.error('❌ Server inference error:', error);
          inference_ts = Date.now();
        }
      } else {
        console.warn('⚠️ SERVER mode: No socket connection available for server inference');
      }
    }

    const result = {
      frame_id,
      capture_ts,
      recv_ts,
      inference_ts,
      detections
    };
    
    // Send detection results to parent component
    if (onDetectionResult) {
      onDetectionResult(result);
    }
    
    // Send detection results to phone via data channel
    if (dataChannel.current && dataChannel.current.readyState === 'open') {
      try {
        dataChannel.current.send(JSON.stringify(result));
        console.log(`📤 BROWSER Sent detection results to phone: ${result.detections.length} detections`);
      } catch (error) {
        console.error('❌ BROWSER Error sending detection results to phone:', error);
      }
    }
    
    return result;
  };

  const runYoloInference = async (canvas: HTMLCanvasElement): Promise<Detection[]> => {
    try {
      const imageData = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      const detections = await runYoloModel(imageData);
      return detections;
    } catch (error) {
      console.error('❌ YOLO inference error:', error);
      return [];
    }
  };

  const calculateFPS = () => {
    const now = Date.now();
    const windowMs = 10000; // 10 second window
    
    // Remove timestamps older than window
    frameTimestamps.current = frameTimestamps.current.filter(timestamp => now - timestamp <= windowMs);
    
    if (frameTimestamps.current.length < 2) return 0;
    
    // Calculate FPS based on actual frame timestamps
    const timeSpanMs = frameTimestamps.current[frameTimestamps.current.length - 1] - frameTimestamps.current[0];
    const timeSpanSeconds = timeSpanMs / 1000;
    
    return timeSpanSeconds > 0 ? (frameTimestamps.current.length - 1) / timeSpanSeconds : 0;
  };

  const updateLatencyMetrics = async (result: any) => {
    const e2eLatency = Date.now() - result.capture_ts;
    latencyHistory.current.push(e2eLatency);
    
    // Keep only last 100 measurements
    if (latencyHistory.current.length > 100) {
      latencyHistory.current.shift();
    }
    
    const sorted = [...latencyHistory.current].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    
    // Calculate bandwidth from WebRTC stats
    let uplink = 0;
    let downlink = 0;
    
    if (peerConnection.current) {
      try {
        const stats = await peerConnection.current.getStats();
        let bytesSent = 0;
        let bytesReceived = 0;
        
        // Find the active candidate pair with actual data transfer
        let activePair: any = null;
        let maxBytes = 0;
        stats.forEach((report: any) => {
          if (report.type === 'candidate-pair' && (report.bytesSent || 0) > maxBytes) {
            maxBytes = report.bytesSent || 0;
            activePair = report;
          }
        });
        
        if (activePair) {
          bytesSent = activePair.bytesSent || 0;
          bytesReceived = activePair.bytesReceived || 0;
          
          // Include data channel stats separately if needed
          stats.forEach((report: any) => {
            if (report.type === 'data-channel') {
              bytesSent += report.bytesSent || 0;
              bytesReceived += report.bytesReceived || 0;
            }
          });
        }
        
        // Store current bandwidth measurement
        const now = Date.now();
        bandwidthHistory.current.push({ timestamp: now, bytesSent, bytesReceived });
        
        // Keep only last 10 measurements (for ~5 second window)
        if (bandwidthHistory.current.length > 10) {
          bandwidthHistory.current.shift();
        }
        
        // Calculate bandwidth rate if we have at least 2 measurements
        if (bandwidthHistory.current.length >= 2) {
          // Use consecutive measurements to avoid WebRTC stats reset issues
          const latest = bandwidthHistory.current[bandwidthHistory.current.length - 1];
          const previous = bandwidthHistory.current[bandwidthHistory.current.length - 2];
          
          const timeDiffSeconds = (latest.timestamp - previous.timestamp) / 1000;
          const bytesSentDiff = latest.bytesSent - previous.bytesSent;
          const bytesReceivedDiff = latest.bytesReceived - previous.bytesReceived;
          
          if (timeDiffSeconds > 0) {
            // Calculate raw bandwidth and clamp negative values to zero
            const rawUplink = (bytesSentDiff * 8) / (timeDiffSeconds * 1000); // kbps
            const rawDownlink = (bytesReceivedDiff * 8) / (timeDiffSeconds * 1000); // kbps
            
            // Clamp negative values to zero (can happen when WebRTC stats reset)
            uplink = Math.max(0, rawUplink);
            downlink = Math.max(0, rawDownlink);
          }
        }
      } catch (error) {
        console.error('Error getting WebRTC stats:', error);
      }
    }
    
    onMetricsUpdate({
      e2eLatency: {
        current: e2eLatency,
        median,
        p95
      },
      processingFps: calculateFPS(),
      uplink,
      downlink,
      serverLatency: result.inference_ts - result.recv_ts,
      networkLatency: result.recv_ts - result.capture_ts,
      framesProcessed: frameCounter.current
    });
  };

  const startMetricsCollection = () => {
    frameCounter.current = 0;
    latencyHistory.current = [];
    bandwidthHistory.current = [];
    
    metricsInterval.current = setInterval(() => {
      // Frame counter no longer reset - using timestamp-based FPS calculation
    }, 30000);
  };

  const stopMetricsCollection = () => {
    if (metricsInterval.current) {
      clearInterval(metricsInterval.current);
      metricsInterval.current = null;
    }
  };

  const setupSocketListeners = () => {
    if (!socket) return;

    socket.on('peer-joined', (data) => {
      if (data.type === 'phone') {
        console.log('📱 Phone connected');
        // Browser should create offer when phone joins
        setTimeout(() => {
          createOffer();
        }, 100); // Small delay to ensure connection is ready
      }
    });

    // Handle detection results from server
    socket.on('detection-result', (result) => {
      if (onDetectionResult) {
        onDetectionResult(result);
      }
    });

    socket.on('answer', async (data) => {
      if (peerConnection.current) {
        try {
          await peerConnection.current.setRemoteDescription(data.answer);
        } catch (error) {
          console.error('❌ Error handling answer:', error);
        }
      }
    });

    socket.on('ice-candidate', async (data) => {
      if (peerConnection.current && data.candidate) {
        try {
          await peerConnection.current.addIceCandidate(data.candidate);
        } catch (error) {
          console.error('❌ Error adding ICE candidate:', error);
        }
      }
    });

    socket.on('peer-left', (data) => {
      if (data.type === 'phone') {
        console.log('📱 Phone disconnected');
        // Clear video element
        if (videoRef.current) {
          videoRef.current.srcObject = null;
          // Remove any display canvas and restore visibility
          const displayCanvas = videoRef.current.parentElement?.querySelector('.display-canvas') as HTMLCanvasElement | null;
          if (displayCanvas) {
            displayCanvas.remove();
          }
          videoRef.current.style.opacity = '';
        }
        // Clear remote stream reference
        remoteStream.current = null;
        // Stop detection
        isDetecting.current = false;
        stopMetricsCollection();
      }
    });
  };

  const createOffer = async () => {
    if (!peerConnection.current) {
      return;
    }

    try {
      const offer = await peerConnection.current.createOffer();
      await peerConnection.current.setLocalDescription(offer);
      
      if (socket) {
        socket.emit('offer', {
          room: roomId,
          offer
        });
      }
    } catch (error) {
      console.error('❌ Error creating offer:', error);
    }
  };

  const cleanup = () => {
    isDetecting.current = false;
    stopMetricsCollection();
    
    // Clear video element
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      // Remove any display canvas and restore visibility
      const displayCanvas = videoRef.current.parentElement?.querySelector('.display-canvas') as HTMLCanvasElement | null;
      if (displayCanvas) {
        displayCanvas.remove();
      }
      videoRef.current.style.opacity = '';
    }
    
    // Clear remote stream reference
    remoteStream.current = null;
    
    if (dataChannel.current) {
      dataChannel.current.close();
    }
    
    if (peerConnection.current) {
      peerConnection.current.close();
    }
  };

  return null;
});

WebRTCManager.displayName = 'WebRTCManager';

export default WebRTCManager;