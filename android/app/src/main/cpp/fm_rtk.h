/* Fency : moteur RTK (RTKLIB demo5) alimenté par les mesures brutes GNSS
 * d'Android (mobile) et un flux RTCM3 NTRIP (base). Indépendant de JNI pour
 * pouvoir être testé sur PC. */
#ifndef FM_RTK_H
#define FM_RTK_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct fm_rtk fm_rtk_t;

typedef struct {
    double elmask_deg;   /* masque d'élévation (degrés) */
    double snrmask_dbhz; /* SNR minimal (dB-Hz), 0 = désactivé */
    int    armode;       /* 0 = off, 1 = continu, 3 = fix-and-hold */
    int    use_gal;      /* utiliser Galileo */
    int    use_bds;      /* utiliser BeiDou */
    int    use_glo;      /* utiliser GLONASS (désactivé par défaut sur smartphone) */
    double ar_ratio;     /* seuil du ratio-test de fixation des ambiguïtés */
} fm_opts_t;

/* Indices du tableau de sortie de fm_rtk_rover() */
enum {
    FM_OUT_STAT = 0, /* 0 aucune, 1 FIX, 2 FLOAT, 4 DGNSS, 5 autonome */
    FM_OUT_LAT, FM_OUT_LON, FM_OUT_HGT,    /* degrés, degrés, m (ellipsoïde) */
    FM_OUT_NSAT, FM_OUT_AGE, FM_OUT_RATIO, /* satellites, âge corrections (s), ratio AR */
    FM_OUT_SDN, FM_OUT_SDE, FM_OUT_SDU,    /* écarts-types N/E/U (m) */
    FM_OUT_X, FM_OUT_Y, FM_OUT_Z,          /* ECEF (m) */
    FM_OUT_N
};

/* Bits retournés par fm_rtk_base() */
#define FM_BASE_OBS 1 /* nouvelle époque d'observations de la base */
#define FM_BASE_EPH 2 /* éphéméride reçue */
#define FM_BASE_POS 4 /* position de la base reçue (1005/1006) */

void fm_default_opts(fm_opts_t *o);
fm_rtk_t *fm_rtk_new(const fm_opts_t *o);
void fm_rtk_free(fm_rtk_t *r);

/* Octets RTCM3 bruts de la base (flux NTRIP). */
int fm_rtk_base(fm_rtk_t *r, const uint8_t *data, int len);

/* Position de la base connue ? (sinon le RTK est impossible) */
int fm_rtk_has_base(const fm_rtk_t *r, double *ecef_out);
int fm_rtk_eph_count(const fm_rtk_t *r);

/* Une époque du mobile : n signaux (un par satellite et par fréquence).
 *  sys  : 'G' GPS, 'E' Galileo, 'C' BeiDou, 'R' GLONASS
 *  codes: 2 caractères RINEX 3 par signal concaténés ("1C5Q1C...")
 *  P    : pseudo-distance (m), 0 si absente
 *  L    : phase (cycles), 0 si absente
 *  D    : Doppler (Hz)
 *  snr  : C/N0 (dB-Hz)
 *  lli  : indicateur de perte de verrouillage (bit 0 saut de cycle, bit 1 demi-cycle)
 *  out  : FM_OUT_N doubles
 * Retourne le statut (FM_OUT_STAT) ou -1 en cas d'erreur. */
int fm_rtk_rover(fm_rtk_t *r, int week, double tow, int n,
                 const char *sys, const int *prn, const char *codes,
                 const double *P, const double *L, const double *D,
                 const double *snr, const int *lli, double *out);

/* Dernier message d'erreur de RTKLIB (diagnostic). */
const char *fm_rtk_errmsg(const fm_rtk_t *r);

#ifdef __cplusplus
}
#endif
#endif
