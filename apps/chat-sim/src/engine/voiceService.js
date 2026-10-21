/**
 * Cross-platform Voice & Speech I/O service using Web Speech API
 * (SpeechRecognition and SpeechSynthesis).
 */

class VoiceService {
  constructor() {
    this.recognition = null;
    this.isListening = false;
    this._initRecognition();
  }

  _initRecognition() {
    if (typeof window !== "undefined") {
      const SpeechRecognition =
        window.SpeechRecognition ||
        window.webkitSpeechRecognition ||
        window.mozSpeechRecognition ||
        window.msSpeechRecognition;

      if (SpeechRecognition) {
        this.recognition = new SpeechRecognition();
        this.recognition.continuous = false;
        this.recognition.interimResults = false;
        this.recognition.lang = "en-US";
      }
    }
  }

  isSpeechRecognitionSupported() {
    return Boolean(this.recognition);
  }

  isSpeechSynthesisSupported() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  /**
   * Listen to user speech from microphone and resolve with the transcribed text.
   */
  startListening() {
    return new Promise((resolve, reject) => {
      if (!this.recognition) {
        return reject(
          new Error("Speech recognition is not supported in this browser."),
        );
      }

      if (this.isListening) {
        try {
          this.recognition.abort();
        } catch (_) {}
      }

      this.isListening = true;

      this.recognition.onresult = (event) => {
        this.isListening = false;
        const transcript = event.results?.[0]?.[0]?.transcript || "";
        resolve(transcript);
      };

      this.recognition.onerror = (event) => {
        this.isListening = false;
        reject(new Error(event.error || "Speech recognition error"));
      };

      this.recognition.onend = () => {
        this.isListening = false;
      };

      try {
        this.recognition.start();
      } catch (err) {
        this.isListening = false;
        reject(err);
      }
    });
  }

  stopListening() {
    if (this.recognition && this.isListening) {
      try {
        this.recognition.stop();
      } catch (_) {}
      this.isListening = false;
    }
  }

  /**
   * Speak a text response aloud via browser SpeechSynthesis.
   */
  speak(text, { onEnd, onError } = {}) {
    if (!this.isSpeechSynthesisSupported() || !text) {
      return false;
    }

    try {
      window.speechSynthesis.cancel(); // Stop prior speech
      const utterance = new window.SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.lang = "en-US";

      if (onEnd) utterance.onend = onEnd;
      if (onError) utterance.onerror = onError;

      window.speechSynthesis.speak(utterance);
      return true;
    } catch (err) {
      console.warn("Speech synthesis failed:", err);
      return false;
    }
  }

  stopSpeaking() {
    if (this.isSpeechSynthesisSupported()) {
      window.speechSynthesis.cancel();
    }
  }
}

export const voiceService = new VoiceService();
