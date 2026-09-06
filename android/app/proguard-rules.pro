# The JNI bridge's native methods are resolved by name from C++, so R8 must not
# rename or strip them (PRD commit 7).
-keepclasseswithmembernames class * {
    native <methods>;
}
