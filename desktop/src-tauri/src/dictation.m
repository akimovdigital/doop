#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <Speech/Speech.h>
#include <stdint.h>
#include <stdbool.h>

typedef void (*DictationCallback)(uint64_t, uint32_t, const char *);

static uint64_t activeId;
static DictationCallback notify;
static AVAudioEngine *audio;
static SFSpeechRecognizer *recognizer API_AVAILABLE(macos(10.15));
static SFSpeechAudioBufferRecognitionRequest *request API_AVAILABLE(macos(10.15));
static SFSpeechRecognitionTask *task API_AVAILABLE(macos(10.15));

static void stopAudio(void) {
    if (!audio) return;
    [audio.inputNode removeTapOnBus:0];
    [audio stop];
    audio = nil;
}

API_AVAILABLE(macos(10.15))
static void finish(uint64_t session, uint32_t event) {
    if (activeId != session) return;
    activeId = 0;
    DictationCallback callback = notify;
    notify = NULL;
    stopAudio();
    [task cancel];
    task = nil;
    request = nil;
    recognizer = nil;
    callback(session, event, NULL);
}

bool doop_dictation_available(const char *language) {
    if (@available(macOS 10.15, *)) {
        NSBundle *bundle = NSBundle.mainBundle;
        if (![bundle objectForInfoDictionaryKey:@"NSMicrophoneUsageDescription"] ||
            ![bundle objectForInfoDictionaryKey:@"NSSpeechRecognitionUsageDescription"]) return false;
        SFSpeechRecognizerAuthorizationStatus speechStatus = SFSpeechRecognizer.authorizationStatus;
        AVAuthorizationStatus micStatus = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
        if (speechStatus == SFSpeechRecognizerAuthorizationStatusDenied ||
            speechStatus == SFSpeechRecognizerAuthorizationStatusRestricted ||
            micStatus == AVAuthorizationStatusDenied || micStatus == AVAuthorizationStatusRestricted) return false;
        NSLocale *locale = [NSLocale localeWithLocaleIdentifier:@(language)];
        SFSpeechRecognizer *candidate = [[SFSpeechRecognizer alloc] initWithLocale:locale];
        return candidate && candidate.isAvailable;
    }
    return false;
}

API_AVAILABLE(macos(10.15))
static void beginListening(uint64_t session, NSLocale *locale) {
    if (session != activeId) return;
    recognizer = [[SFSpeechRecognizer alloc] initWithLocale:locale];
    if (!recognizer.isAvailable) {
        finish(session, 3);
        return;
    }

    AVAudioEngine *engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode *input = engine.inputNode;
    AVAudioFormat *format = [input outputFormatForBus:0];
    if (!format.sampleRate || !format.channelCount) {
        finish(session, 3);
        return;
    }

    SFSpeechAudioBufferRecognitionRequest *buffers = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    buffers.shouldReportPartialResults = YES;
    if (recognizer.supportsOnDeviceRecognition) buffers.requiresOnDeviceRecognition = YES;
    request = buffers;
    audio = engine;
    [input installTapOnBus:0 bufferSize:1024 format:format block:^(AVAudioPCMBuffer *buffer, __unused AVAudioTime *time) {
        [buffers appendAudioPCMBuffer:buffer];
    }];
    [engine prepare];
    NSError *error = nil;
    if (![engine startAndReturnError:&error]) {
        finish(session, 3);
        return;
    }

    task = [recognizer recognitionTaskWithRequest:buffers resultHandler:^(SFSpeechRecognitionResult *result, NSError *problem) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (activeId != session) return;
            if (result) notify(session, result.isFinal ? 1 : 0, result.bestTranscription.formattedString.UTF8String);
            if (result.isFinal || problem) finish(session, problem && audio ? 3 : 2);
        });
    }];
}

void doop_dictation_start(uint64_t session, const char *language, DictationCallback callback) {
    if (@available(macOS 10.15, *)) {
        if (activeId) finish(activeId, 2);
        activeId = session;
        notify = callback;
        NSLocale *locale = [NSLocale localeWithLocaleIdentifier:@(language)];
        [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (activeId != session) return;
                if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
                    finish(session, 3);
                    return;
                }
                [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (granted) beginListening(session, locale);
                        else finish(session, 3);
                    });
                }];
            });
        }];
    } else {
        callback(session, 3, NULL);
    }
}

void doop_dictation_stop(uint64_t session, bool cancel) {
    if (@available(macOS 10.15, *)) {
        if (activeId != session) return;
        if (cancel || !audio) {
            finish(session, 2);
            return;
        }
        stopAudio();
        [request endAudio];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 1500 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            finish(session, 2);
        });
    }
}
