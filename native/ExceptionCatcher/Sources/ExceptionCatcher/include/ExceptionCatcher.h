#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs `block` and returns the Objective-C exception it raised, or nil when
/// it returned normally. Only for framework calls that report misuse by
/// raising (AVFAudio does); the exception is the caller's to log and report.
FOUNDATION_EXPORT NSException *_Nullable CGCatchException(NS_NOESCAPE void (^block)(void));

NS_ASSUME_NONNULL_END
