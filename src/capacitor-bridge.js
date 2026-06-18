// Capacitor 네이티브 플러그인 브릿지 — esbuild 로 번들링 후 public/js/capacitor-bridge.js 에 출력
import { registerPlugin }  from '@capacitor/core';
import { TextToSpeech }    from '@capacitor-community/text-to-speech';
import { NativeAudio }     from '@capacitor-community/native-audio';

// 화면 잠금 백그라운드 위치 추적·위험구역 감지 로컬 플러그인
const BackgroundSafety = registerPlugin('BackgroundSafety');

window.CapBridge = { TextToSpeech, NativeAudio, BackgroundSafety };
