#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Swift cannot catch NSExceptions. Background-session
/// uploadTask(with:fromFile:) raises NSInvalidArgumentException when the file
/// is missing/unreadable at task-creation time — which killed the app
/// (PROMPTLY-IOS-2Y/2Z/31/37). This shim converts the exception into a value.
@interface ObjCExceptionCatcher : NSObject
/// Runs the block; returns nil on success, the NSException if one was raised.
+ (nullable NSException *)catchException:(void(NS_NOESCAPE ^)(void))block;
@end

NS_ASSUME_NONNULL_END
