/* Test de bout en bout du pont RTK sur PC, avec les données de RTKLIB :
 * deux stations GSI (Japon) distantes d'environ 3 km, le 2005-04-02.
 *  - la base (3040) est encodée en RTCM3 (1006 + 1019 + MSM4 1074), comme un flux NTRIP ;
 *  - le mobile (0759) est injecté signal par signal, comme depuis Android.
 * On vérifie que la solution est FIXE et proche de la position connue du mobile. */
#include <stdio.h>
#include <string.h>
#include <math.h>
#include "rtklib.h"
#include "../fm_rtk.h"

static void send(fm_rtk_t *r, rtcm_t *enc, int type, int *flags)
{
    if (gen_rtcm3(enc, type, 0, 0)) *flags |= fm_rtk_base(r, enc->buff, enc->nbyte);
}

int main(int argc, char **argv)
{
    const char *dir = argc > 1 ? argv[1] : ".";
    char f[512];
    obs_t bobs = {0}, robs = {0};
    nav_t nav = {0};
    sta_t bsta = {0}, rsta = {0};
    rtcm_t enc;
    int i, j, k, flags = 0, nep = 0, nfix = 0, nfloat = 0, lasti = 0;
    double out[FM_OUT_N], rref[3], pos[3], dr[3], enu[3], maxh = 0;

    snprintf(f, sizeof f, "%s/30400920.05o", dir); readrnx(f, 2, "", &bobs, NULL, &bsta);
    snprintf(f, sizeof f, "%s/07590920.05o", dir); readrnx(f, 1, "", &robs, NULL, &rsta);
    snprintf(f, sizeof f, "%s/07590920.05n", dir); readrnx(f, 0, "", NULL, &nav, NULL);
    snprintf(f, sizeof f, "%s/30400920.05n", dir); readrnx(f, 0, "", NULL, &nav, NULL);
    sortobs(&bobs); sortobs(&robs);
    printf("base: %d obs, mobile: %d obs, eph: %d\n", bobs.n, robs.n, nav.n);
    if (bobs.n == 0 || robs.n == 0 || nav.n == 0) return 1;
    /* référence : solution statique FIXE de RTKLIB (rnx2rtkp -p 3) sur ces 2 h ;
     * la position APPROX de l'en-tête RINEX est décalée d'environ 15 cm. */
    rref[0] = -3976219.6641; rref[1] = 3382372.5424; rref[2] = 3652513.0558;

    /* données de 2005 : on recale l'horloge de RTKLIB (semaine GPS sur 10 bits des éphémérides) */
    timeset(gpst2utc(robs.data[0].time));
    enc.time = robs.data[0].time;
    fm_rtk_t *r = fm_rtk_new(NULL);
    init_rtcm(&enc);
    enc.time = robs.data[0].time;
    enc.sta = bsta;
    send(r, &enc, 1006, &flags);
    if (!fm_rtk_has_base(r, NULL)) { printf("ECHEC: position de base non decodee\n"); return 1; }


    int bi = 0, ri = 0, maxep = 240; /* 2 h à 30 s */
    while (ri < robs.n && nep < maxep) {
        gtime_t t = robs.data[ri].time;
        /* époque de base correspondante */
        while (bi < bobs.n && timediff(bobs.data[bi].time, t) < -0.5) bi++;
        int bn = 0;
        while (bi + bn < bobs.n && fabs(timediff(bobs.data[bi + bn].time, t)) < 0.5) bn++;
        if (bn) {
            /* éphémérides les plus proches, renvoyées quand elles changent */
            for (j = 0; j < bn; j++) {
                int sat = bobs.data[bi + j].sat, best = -1; double dt = 1e9;
                for (k = 0; k < nav.n; k++) {
                    if (nav.eph[k].sat != sat) continue;
                    double d = fabs(timediff(nav.eph[k].toe, t));
                    if (d < dt) { dt = d; best = k; }
                }
                if (best < 0 || enc.nav.eph[sat - 1].iode == nav.eph[best].iode && enc.nav.eph[sat - 1].sat) continue;
                enc.nav.eph[sat - 1] = nav.eph[best];
                enc.ephsat = sat;
                send(r, &enc, 1019, &flags);
            }
            enc.time = bobs.data[bi].time; /* heure de la BASE (sauts d'horloge de 1 ms) */
            enc.obs.n = bn;
            memcpy(enc.obs.data, bobs.data + bi, sizeof(obsd_t) * bn);
            send(r, &enc, 1074, &flags);
        }
        /* époque du mobile, aplatie en signaux comme côté Android */
        int rn = 0;
        while (ri + rn < robs.n && fabs(timediff(robs.data[ri + rn].time, t)) < 1e-3) rn++;
        char sys[256], codes[512]; int prn[256], lli[256]; double P[256], L[256], D[256], S[256];
        int n = 0;
        for (j = 0; j < rn; j++) {
            obsd_t *o = robs.data + ri + j;
            int p, s = satsys(o->sat, &p);
            for (k = 0; k < NFREQ; k++) {
                if (o->code[k] == CODE_NONE || (o->P[k] == 0 && o->L[k] == 0)) continue;
                sys[n] = s == SYS_GPS ? 'G' : '?'; prn[n] = p;
                memcpy(codes + 2 * n, code2obs(o->code[k]), 2);
                P[n] = o->P[k]; L[n] = o->L[k]; D[n] = o->D[k];
                S[n] = o->SNR[k] ? o->SNR[k] * SNR_UNIT : 45.0; lli[n] = o->LLI[k];
                n++;
            }
        }
        /* Android ne trie pas les mesures : on inverse l'ordre pour le vérifier */
        for (j = 0; j < n / 2; j++) {
            int m = n - 1 - j; char tc; int ti; double td;
            tc = sys[j]; sys[j] = sys[m]; sys[m] = tc;
            ti = prn[j]; prn[j] = prn[m]; prn[m] = ti;
            ti = lli[j]; lli[j] = lli[m]; lli[m] = ti;
            tc = codes[2*j]; codes[2*j] = codes[2*m]; codes[2*m] = tc;
            tc = codes[2*j+1]; codes[2*j+1] = codes[2*m+1]; codes[2*m+1] = tc;
            td = P[j]; P[j] = P[m]; P[m] = td; td = L[j]; L[j] = L[m]; L[m] = td;
            td = D[j]; D[j] = D[m]; D[m] = td; td = S[j]; S[j] = S[m]; S[m] = td;
        }
        int week; double tow = time2gpst(t, &week);
        int st = fm_rtk_rover(r, week, tow, n, sys, prn, codes, P, L, D, S, lli, out);
        ri += rn; nep++;
        if (st == SOLQ_FIX) nfix++; else if (st == SOLQ_FLOAT) nfloat++;
        if (st == SOLQ_FIX && nep > 20) {
            dr[0] = out[FM_OUT_X] - rref[0]; dr[1] = out[FM_OUT_Y] - rref[1]; dr[2] = out[FM_OUT_Z] - rref[2];
            ecef2pos(rref, pos); ecef2enu(pos, dr, enu);
            double h = sqrt(enu[0] * enu[0] + enu[1] * enu[1]);
            if (h > maxh) maxh = h;
            lasti = nep;
        }
        if (nep % 40 == 0)
            printf("ep %3d stat=%d ns=%d ratio=%.1f age=%.1f lat=%.8f lon=%.8f sd=(%.3f,%.3f,%.3f) %s\n",
                   nep, st, (int)out[FM_OUT_NSAT], out[FM_OUT_RATIO], out[FM_OUT_AGE], out[FM_OUT_LAT],
                   out[FM_OUT_LON], out[FM_OUT_SDN], out[FM_OUT_SDE], out[FM_OUT_SDU], fm_rtk_errmsg(r));
    }
    dr[0] = out[FM_OUT_X] - rref[0]; dr[1] = out[FM_OUT_Y] - rref[1]; dr[2] = out[FM_OUT_Z] - rref[2];
    ecef2pos(rref, pos); ecef2enu(pos, dr, enu);
    printf("epoques=%d FIX=%d FLOAT=%d eph=%d derniere ecart E=%.3f N=%.3f U=%.3f m ; ecart horizontal max (FIX)=%.3f m\n",
           nep, nfix, nfloat, fm_rtk_eph_count(r), enu[0], enu[1], enu[2], maxh);
    fm_rtk_free(r);
    (void)lasti; (void)flags;
    int ok = nfix > nep / 2 && maxh < 0.10;
    printf(ok ? "OK\n" : "ECHEC\n");
    return ok ? 0 : 1;
}
