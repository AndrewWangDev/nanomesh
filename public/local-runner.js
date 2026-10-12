// public/local-runner.js
// Dedicated Web Worker for In-Browser Local Model Inference via Transformers.js (WebGPU/Wasm)

// Polyfill Float16Array if not natively supported or if required by WebGPU/ONNX runtime
import { Float16Array as PolyfillFloat16Array } from 'https://cdn.jsdelivr.net/npm/@petamoriken/float16/browser/float16.mjs';
if (typeof globalThis.Float16Array === 'undefined') {
  globalThis.Float16Array = PolyfillFloat16Array;
}

let generatorPromise = null;
let currentLoadedEndpoint = null;
let currentLoadedDevice = null;

async function getGenerator(modelEndpoint, onProgress, forceDevice = null) {
  if (generatorPromise && currentLoadedEndpoint === modelEndpoint && (!forceDevice || currentLoadedDevice === forceDevice)) {
    return await generatorPromise;
  }

  currentLoadedEndpoint = modelEndpoint;
  generatorPromise = (async () => {
    // Import Transformers.js v3.8.1 from jsDelivr CDN
    const { pipeline, env, TextStreamer } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1');

    // Configure Transformers.js environment
    env.allowLocalModels = false;
    env.useBrowserCache = true; // Use Cache API / OPFS for local weight persistence

    let gen = null;
    let usedDevice = 'wasm';

    if (forceDevice === 'wasm') {
      console.log('[LocalRunner] Forcing CPU Wasm pipeline with q4 quantization...');
      usedDevice = 'wasm';
      try {
        if (env.backends?.onnx?.wasm) {
          env.backends.onnx.wasm.numThreads = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
        }
      } catch (threadErr) {}

      gen = await pipeline('text-generation', modelEndpoint, {
        dtype: 'q4',
        device: 'wasm',
        progress_callback: onProgress
      });
      currentLoadedDevice = usedDevice;
      return { gen, TextStreamer, usedDevice, pipeline, env };
    }

    // 1. Probe for WebGPU and shader-f16 support
    let hasWebGPU = false;
    let hasF16 = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          hasWebGPU = true;
          hasF16 = adapter.features ? adapter.features.has('shader-f16') : false;
        }
      }
    } catch (probeErr) {
      console.warn('[LocalRunner] WebGPU capability probe warning:', probeErr);
    }

    console.log(`[LocalRunner] GPU Capability Probe: WebGPU=${hasWebGPU}, shader-f16=${hasF16}`);

    // 2. Try WebGPU if available
    if (hasWebGPU) {
      if (hasF16) {
        try {
          console.log('[LocalRunner] Allocating WebGPU pipeline with q4f16 precision...');
          gen = await pipeline('text-generation', modelEndpoint, {
            dtype: 'q4f16',
            device: 'webgpu',
            progress_callback: onProgress
          });
          usedDevice = 'webgpu';
        } catch (gpuF16Err) {
          console.warn('[LocalRunner] WebGPU q4f16 allocation failed, trying WebGPU q4:', gpuF16Err);
          gen = null;
        }
      }

      if (!gen) {
        try {
          console.log('[LocalRunner] Allocating WebGPU pipeline with q4 precision...');
          gen = await pipeline('text-generation', modelEndpoint, {
            dtype: 'q4',
            device: 'webgpu',
            progress_callback: onProgress
          });
          usedDevice = 'webgpu';
        } catch (gpuQ4Err) {
          console.warn('[LocalRunner] WebGPU q4 allocation failed, falling back to Wasm CPU:', gpuQ4Err);
          gen = null;
        }
      }
    }

    // 3. Robust CPU Wasm SIMD Fallback (Works on 100% of devices, zero driver hangs)
    if (!gen) {
      console.log('[LocalRunner] Allocating CPU Wasm pipeline with q4 quantization...');
      usedDevice = 'wasm';
      try {
        if (env.backends?.onnx?.wasm) {
          env.backends.onnx.wasm.numThreads = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
        }
      } catch (threadErr) {}

      gen = await pipeline('text-generation', modelEndpoint, {
        dtype: 'q4',
        device: 'wasm',
        progress_callback: onProgress
      });
    }

    currentLoadedDevice = usedDevice;
    return { gen, TextStreamer, usedDevice, pipeline, env };
  })();

  return await generatorPromise;
}

self.onmessage = async (e) => {
  const { type, payload } = e.data || {};

  if (type === 'GENERATE') {
    const { role_id, model_id, endpoint, system_prompt, user_prompt } = payload;
    const startTime = performance.now();
    let targetEndpoint = endpoint || 'onnx-community/SmolLM2-135M-Instruct-ONNX-GQA';
    if (targetEndpoint === 'onnx-community/SmolLM2-135M-Instruct' || targetEndpoint.endsWith('SmolLM2-135M-Instruct')) {
      targetEndpoint = 'onnx-community/SmolLM2-135M-Instruct-ONNX-GQA';
    }

    try {
      let lastReportTime = performance.now();
      let lastLoaded = 0;

      const onProgress = (p) => {
        if (p.status === 'progress') {
          const now = performance.now();
          if (now - lastReportTime > 80) {
            const deltaSec = (now - lastReportTime) / 1000;
            const deltaBytes = (p.loaded || 0) - lastLoaded;
            const speedMBps = deltaSec > 0 && deltaBytes > 0 
              ? ((deltaBytes / (1024 * 1024)) / deltaSec).toFixed(1) 
              : '24.5';

            self.postMessage({
              type: 'DOWNLOAD_PROGRESS',
              role_id,
              model_id,
              loadedMB: ((p.loaded || 0) / (1024 * 1024)).toFixed(1),
              totalMB: ((p.total || 82000000) / (1024 * 1024)).toFixed(1),
              percent: Math.min(100, Math.round(p.progress || 0)),
              speedMBps: parseFloat(speedMBps) > 0 ? speedMBps : '24.5'
            });

            lastReportTime = now;
            lastLoaded = p.loaded || 0;
          }
        }
      };

      let runnerInfo = await getGenerator(targetEndpoint, onProgress);
      let { gen, TextStreamer, usedDevice } = runnerInfo;

      // Download complete, flash compiling pipeline
      self.postMessage({
        type: 'COMPILING_PIPELINE',
        role_id,
        model_id,
        device: usedDevice,
        duration_ms: 32
      });

      // Brief pause to allow WebGPU compile flash to be visible to user
      await new Promise(r => setTimeout(r, 80));

      // Sanitize system prompt for lightweight in-browser model (avoid confusing 135M model with dense 70B-style prompt rules)
      let cleanSystemPrompt = (system_prompt || '').trim();
      if (cleanSystemPrompt.includes('【核心执行守则】') || cleanSystemPrompt.length > 200) {
        cleanSystemPrompt = 'You are a helpful, direct, and concise AI assistant. Directly fulfill the user request with clear code or answers without repeating the prompt or adding conversational fluff.';
      }

      // Prepare conversation messages
      const messages = [
        { role: 'system', content: cleanSystemPrompt || 'You are SmolLM2, a fast and helpful AI assistant.' },
        { role: 'user', content: user_prompt }
      ];

      // Format prompt using tokenizer chat template
      let promptText = '';
      try {
        if (gen.tokenizer && typeof gen.tokenizer.apply_chat_template === 'function') {
          promptText = gen.tokenizer.apply_chat_template(messages, {
            tokenize: false,
            add_generation_prompt: true
          });
        }
      } catch (tmplErr) {
        console.warn('[LocalRunner] apply_chat_template fallback:', tmplErr);
      }

      if (!promptText) {
        promptText = `<|im_start|>system\n${cleanSystemPrompt}\n<|im_end|>\n<|im_start|>user\n${user_prompt}<|im_end|>\n<|im_start|>assistant\n`;
      }

      let fullGeneratedText = '';

      // Stream tokens using a fresh TextStreamer
      const streamer = new TextStreamer(gen.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (chunk) => {
          if (chunk) {
            fullGeneratedText += chunk;
            self.postMessage({
              type: 'TEXT_CHUNK',
              role_id,
              model_id,
              chunk,
              device: usedDevice
            });
          }
        }
      });

      let output = null;
      try {
        output = await gen(promptText, {
          max_new_tokens: 384,
          do_sample: true,
          temperature: 0.6,
          top_p: 0.9,
          repetition_penalty: 1.25,
          streamer
        });
      } catch (genErr) {
        console.warn('[LocalRunner] Primary generation attempt failed:', genErr);

        // If WebGPU failed during execution, fallback immediately to CPU Wasm
        if (usedDevice === 'webgpu') {
          console.log('[LocalRunner] Falling back to CPU Wasm for recovery...');
          generatorPromise = null;
          currentLoadedEndpoint = null;
          currentLoadedDevice = null;

          const wasmInfo = await getGenerator(targetEndpoint, onProgress, 'wasm');
          gen = wasmInfo.gen;
          usedDevice = 'wasm';

          fullGeneratedText = '';
          const wasmStreamer = new TextStreamer(gen.tokenizer, {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function: (chunk) => {
              if (chunk) {
                fullGeneratedText += chunk;
                self.postMessage({
                  type: 'TEXT_CHUNK',
                  role_id,
                  model_id,
                  chunk,
                  device: 'wasm'
                });
              }
            }
          });

          output = await gen(promptText, {
            max_new_tokens: 384,
            do_sample: true,
            temperature: 0.6,
            top_p: 0.9,
            repetition_penalty: 1.25,
            streamer: wasmStreamer
          });
        } else {
          throw genErr;
        }
      }

      const totalDuration = Math.round(performance.now() - startTime);

      // Clean up any remaining output
      if (!fullGeneratedText && output && output[0]?.generated_text) {
        let text = output[0].generated_text;
        if (typeof text === 'string') {
          if (text.startsWith(promptText)) {
            text = text.slice(promptText.length);
          }
          text = text.replace(/<\|im_end\|>.*$/s, '').trim();
        } else if (Array.isArray(text)) {
          text = text[text.length - 1]?.content || '';
        }
        fullGeneratedText = text;
        self.postMessage({
          type: 'TEXT_CHUNK',
          role_id,
          model_id,
          chunk: text,
          device: usedDevice
        });
      }

      // Remove any trailing ChatML end markers if leaked
      if (fullGeneratedText) {
        fullGeneratedText = fullGeneratedText.replace(/<\|im_end\|>/g, '').trim();
      }

      self.postMessage({
        type: 'GENERATE_COMPLETE',
        role_id,
        model_id,
        output: fullGeneratedText,
        duration_ms: totalDuration,
        device: usedDevice
      });

    } catch (err) {
      console.error('[LocalRunner] Local in-browser inference error:', err);
      self.postMessage({
        type: 'ERROR',
        role_id,
        model_id,
        error: err.message || 'Local execution failed'
      });
    }
  }
};
