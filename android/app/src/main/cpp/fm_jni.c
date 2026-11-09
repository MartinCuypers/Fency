/* Liaison JNI entre io.github.martincuypers.fencemapper.rtk.RtkNative et fm_rtk.c */
#include <jni.h>
#include <stdlib.h>
#include "fm_rtk.h"

#define FN(name) Java_io_github_martincuypers_fencemapper_rtk_RtkNative_##name

JNIEXPORT jlong JNICALL FN(nativeNew)(JNIEnv *env, jclass cls, jdouble elmask, jdouble snrmask,
                                       jint armode, jboolean gal, jboolean bds, jboolean glo,
                                       jdouble ratio)
{
    fm_opts_t o;
    fm_default_opts(&o);
    o.elmask_deg = elmask;
    o.snrmask_dbhz = snrmask;
    o.armode = armode;
    o.use_gal = gal;
    o.use_bds = bds;
    o.use_glo = glo;
    o.ar_ratio = ratio;
    return (jlong)(intptr_t)fm_rtk_new(&o);
}

JNIEXPORT void JNICALL FN(nativeFree)(JNIEnv *env, jclass cls, jlong h)
{
    fm_rtk_free((fm_rtk_t *)(intptr_t)h);
}

JNIEXPORT jint JNICALL FN(nativeBase)(JNIEnv *env, jclass cls, jlong h, jbyteArray data, jint len)
{
    jbyte *b = (*env)->GetByteArrayElements(env, data, NULL);
    int ret = fm_rtk_base((fm_rtk_t *)(intptr_t)h, (const uint8_t *)b, len);
    (*env)->ReleaseByteArrayElements(env, data, b, JNI_ABORT);
    return ret;
}

JNIEXPORT jint JNICALL FN(nativeRover)(JNIEnv *env, jclass cls, jlong h, jint week, jdouble tow,
                                        jint n, jbyteArray sys, jintArray prn, jbyteArray codes,
                                        jdoubleArray P, jdoubleArray L, jdoubleArray D,
                                        jdoubleArray snr, jintArray lli, jdoubleArray out)
{
    jbyte *s = (*env)->GetByteArrayElements(env, sys, NULL);
    jint *p = (*env)->GetIntArrayElements(env, prn, NULL);
    jbyte *c = (*env)->GetByteArrayElements(env, codes, NULL);
    jdouble *pp = (*env)->GetDoubleArrayElements(env, P, NULL);
    jdouble *ll = (*env)->GetDoubleArrayElements(env, L, NULL);
    jdouble *dd = (*env)->GetDoubleArrayElements(env, D, NULL);
    jdouble *sn = (*env)->GetDoubleArrayElements(env, snr, NULL);
    jint *li = (*env)->GetIntArrayElements(env, lli, NULL);
    double o[FM_OUT_N];

    int ret = fm_rtk_rover((fm_rtk_t *)(intptr_t)h, week, tow, n, (const char *)s, p,
                           (const char *)c, pp, ll, dd, sn, li, o);
    (*env)->SetDoubleArrayRegion(env, out, 0, FM_OUT_N, o);

    (*env)->ReleaseByteArrayElements(env, sys, s, JNI_ABORT);
    (*env)->ReleaseIntArrayElements(env, prn, p, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, codes, c, JNI_ABORT);
    (*env)->ReleaseDoubleArrayElements(env, P, pp, JNI_ABORT);
    (*env)->ReleaseDoubleArrayElements(env, L, ll, JNI_ABORT);
    (*env)->ReleaseDoubleArrayElements(env, D, dd, JNI_ABORT);
    (*env)->ReleaseDoubleArrayElements(env, snr, sn, JNI_ABORT);
    (*env)->ReleaseIntArrayElements(env, lli, li, JNI_ABORT);
    return ret;
}

JNIEXPORT jboolean JNICALL FN(nativeHasBase)(JNIEnv *env, jclass cls, jlong h)
{
    return fm_rtk_has_base((fm_rtk_t *)(intptr_t)h, NULL) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jint JNICALL FN(nativeEphCount)(JNIEnv *env, jclass cls, jlong h)
{
    return fm_rtk_eph_count((fm_rtk_t *)(intptr_t)h);
}

JNIEXPORT jstring JNICALL FN(nativeError)(JNIEnv *env, jclass cls, jlong h)
{
    return (*env)->NewStringUTF(env, fm_rtk_errmsg((fm_rtk_t *)(intptr_t)h));
}
