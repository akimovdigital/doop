#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <Speech/Speech.h>
#include <stdint.h>
#include <stdbool.h>

enum {
    DictationInterim,
    DictationFinal,
    DictationEnd,
    DictationError,
    DictationDisabled,
    DictationNoSpeech,
};

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

static uint32_t recognitionOutcome(NSError *error, bool isRecording) {
    for (NSError *cause = error; cause; cause = cause.userInfo[NSUnderlyingErrorKey]) {
        if ([cause.domain isEqualToString:@"kLSRErrorDomain"] && cause.code == 201) return DictationDisabled;
        if ([cause.domain isEqualToString:@"kAFAssistantErrorDomain"] && cause.code == 1110) return DictationNoSpeech;
    }
    return error && isRecording ? DictationError : DictationEnd;
}

API_AVAILABLE(macos(10.15))
static void beginListening(uint64_t session, NSLocale *locale) {
    if (session != activeId) return;
    recognizer = [[SFSpeechRecognizer alloc] initWithLocale:locale];
    if (!recognizer.isAvailable) {
        finish(session, DictationError);
        return;
    }

    AVAudioEngine *engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode *input = engine.inputNode;
    AVAudioFormat *format = [input outputFormatForBus:0];
    if (!format.sampleRate || !format.channelCount) {
        finish(session, DictationError);
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
        finish(session, DictationError);
        return;
    }

    task = [recognizer recognitionTaskWithRequest:buffers resultHandler:^(SFSpeechRecognitionResult *result, NSError *problem) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (activeId != session) return;
            if (result) notify(session, result.isFinal ? DictationFinal : DictationInterim,
                               result.bestTranscription.formattedString.UTF8String);
            if (result.isFinal || problem) finish(session, recognitionOutcome(problem, audio != nil));
        });
    }];
}

void doop_dictation_start(uint64_t session, const char *language, DictationCallback callback) {
    if (@available(macOS 10.15, *)) {
        if (activeId) finish(activeId, DictationEnd);
        activeId = session;
        notify = callback;
        NSLocale *locale = [NSLocale localeWithLocaleIdentifier:@(language)];
        [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (activeId != session) return;
                if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
                    finish(session, DictationError);
                    return;
                }
                [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (granted) beginListening(session, locale);
                        else finish(session, DictationError);
                    });
                }];
            });
        }];
    } else {
        callback(session, DictationError, NULL);
    }
}

void doop_dictation_stop(uint64_t session, bool cancel) {
    if (@available(macOS 10.15, *)) {
        if (activeId != session) return;
        if (cancel || !audio) {
            finish(session, DictationEnd);
            return;
        }
        stopAudio();
        [request endAudio];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 1500 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            finish(session, DictationEnd);
        });
    }
}
