#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "rtklib.h"
#include "fm_rtk.h"

struct fm_rtk {
    rtk_t rtk;
    rtcm_t rtcm;          /* décodeur de la base ; rtcm.nav cumule les éphémérides */
    obsd_t base[MAXOBS];  /* dernière époque de la base */
    int nbase;
    int hasbase;
    obsd_t obs[MAXOBS * 2];
    gtime_t trov;         /* heure GNSS de la dernière époque du mobile */
    char err[256];
};

/* RTKLIB (selsat) exige des observations triées par numéro de satellite. */
static int cmp_sat(const void *a, const void *b)
{
    return (int)((const obsd_t *)a)->sat - (int)((const obsd_t *)b)->sat;
}

void fm_default_opts(fm_opts_t *o)
{
    o->elmask_deg = 15.0;
    o->snrmask_dbhz = 0.0;
    o->armode = ARMODE_FIXHOLD;
    o->use_gal = 1;
    o->use_bds = 1;
    o->use_glo = 0;
    o->ar_ratio = 3.0;
}

fm_rtk_t *fm_rtk_new(const fm_opts_t *o)
{
    fm_opts_t def;
    prcopt_t opt = prcopt_default;
    fm_rtk_t *r = (fm_rtk_t *)calloc(1, sizeof(fm_rtk_t));
    int i, j;

    if (!r) return NULL;
    if (!o) { fm_default_opts(&def); o = &def; }

    opt.mode = PMODE_KINEMA;
    opt.nf = 3;                       /* L1 + (L2) + L5/E5a : smartphones bi-fréquence */
    opt.navsys = SYS_GPS | (o->use_gal ? SYS_GAL : 0) | (o->use_bds ? SYS_CMP : 0) |
                 (o->use_glo ? SYS_GLO : 0);
    opt.elmin = o->elmask_deg * D2R;
    opt.modear = o->armode;
    opt.glomodear = 0;
    opt.bdsmodear = 1;
    opt.thresar[0] = o->ar_ratio;
    opt.ionoopt = IONOOPT_BRDC;
    opt.tropopt = TROPOPT_SAAS;
    opt.dynamics = 1;                 /* le quad se déplace */
    opt.refpos = POSOPT_RTCM;         /* position de base fournie par le flux (1005/1006) */
    opt.outsingle = 1;                /* sortir une position même sans base */
    opt.maxtdiff = 30.0;              /* âge maximal des corrections (s) */
    if (o->snrmask_dbhz > 0) {
        opt.snrmask.ena[0] = 1;
        for (i = 0; i < NFREQ; i++)
            for (j = 0; j < 9; j++) opt.snrmask.mask[i][j] = o->snrmask_dbhz;
    }
    rtkinit(&r->rtk, &opt);
    if (!init_rtcm(&r->rtcm)) { free(r); return NULL; }
    return r;
}

void fm_rtk_free(fm_rtk_t *r)
{
    if (!r) return;
    rtkfree(&r->rtk);
    free_rtcm(&r->rtcm);
    free(r);
}

static void update_base_pos(fm_rtk_t *r)
{
    sta_t *sta = &r->rtcm.sta;
    double pos[3], enu[3], dr[3];
    int i;

    if (norm(sta->pos, 3) <= 0.0) return;
    for (i = 0; i < 3; i++) r->rtk.rb[i] = sta->pos[i];
    /* hauteur d'antenne : delta ENU (deltype 0) ou ECEF (deltype 1) */
    if (sta->deltype == 0) {
        ecef2pos(r->rtk.rb, pos);
        enu[0] = sta->del[0]; enu[1] = sta->del[1]; enu[2] = sta->del[2]; /* 1005/1006 = ARP */
        enu2ecef(pos, enu, dr);
        for (i = 0; i < 3; i++) r->rtk.rb[i] += dr[i];
    } else {
        for (i = 0; i < 3; i++) r->rtk.rb[i] += sta->del[i];
    }
    for (i = 3; i < 6; i++) r->rtk.rb[i] = 0.0;
    r->hasbase = 1;
}

int fm_rtk_base(fm_rtk_t *r, const uint8_t *data, int len)
{
    int i, j, ret, flags = 0;

    /* La semaine GPS des messages RTCM est ambiguë : on la résout avec l'heure
     * GNSS du mobile plutôt qu'avec l'horloge du téléphone. */
    if (r->trov.time) r->rtcm.time = r->trov;
    for (i = 0; i < len; i++) {
        ret = input_rtcm3(&r->rtcm, data[i]);
        if (ret == 1) {               /* époque d'observations complète */
            r->nbase = 0;
            for (j = 0; j < r->rtcm.obs.n && r->nbase < MAXOBS; j++) {
                r->base[r->nbase] = r->rtcm.obs.data[j];
                r->base[r->nbase++].rcv = 2;
            }
            qsort(r->base, r->nbase, sizeof(obsd_t), cmp_sat);
            flags |= FM_BASE_OBS;
        } else if (ret == 2) {
            flags |= FM_BASE_EPH;
        } else if (ret == 5) {
            update_base_pos(r);
            flags |= FM_BASE_POS;
        }
    }
    return flags;
}

int fm_rtk_has_base(const fm_rtk_t *r, double *ecef)
{
    if (ecef && r->hasbase) memcpy(ecef, r->rtk.rb, sizeof(double) * 3);
    return r->hasbase;
}

int fm_rtk_eph_count(const fm_rtk_t *r)
{
    int i, n = 0;
    for (i = 0; i < r->rtcm.nav.n; i++) if (r->rtcm.nav.eph[i].sat) n++;
    for (i = 0; i < r->rtcm.nav.ng; i++) if (r->rtcm.nav.geph[i].sat) n++;
    return n;
}

static int sys_of(char c)
{
    switch (c) {
        case 'G': return SYS_GPS;
        case 'E': return SYS_GAL;
        case 'C': return SYS_CMP;
        case 'R': return SYS_GLO;
        case 'J': return SYS_QZS;
    }
    return SYS_NONE;
}

static int find_or_add(obsd_t *obs, int *n, int sat, gtime_t t)
{
    int i, k;
    for (i = 0; i < *n; i++) if (obs[i].sat == sat) return i;
    if (*n >= MAXOBS) return -1;
    memset(&obs[*n], 0, sizeof(obsd_t));
    obs[*n].time = t;
    obs[*n].sat = (uint8_t)sat;
    obs[*n].rcv = 1;
    for (k = 0; k < NFREQ + NEXOBS; k++) obs[*n].code[k] = CODE_NONE;
    return (*n)++;
}

int fm_rtk_rover(fm_rtk_t *r, int week, double tow, int n,
                 const char *sys, const int *prn, const char *codes,
                 const double *P, const double *L, const double *D,
                 const double *snr, const int *lli, double *out)
{
    gtime_t t = gpst2time(week, tow);
    double pos[3], Q[9], P3[9];
    char code[3] = {0};
    int i, k, s, sat, idx, nu = 0, nobs;

    memset(out, 0, sizeof(double) * FM_OUT_N);
    for (i = 0; i < n; i++) {
        if ((s = sys_of(sys[i])) == SYS_NONE) continue;
        if (!(sat = satno(s, prn[i]))) continue;
        code[0] = codes[2 * i]; code[1] = codes[2 * i + 1];
        uint8_t c = obs2code(code);
        if (c == CODE_NONE) continue;
        if ((idx = code2idx(s, c)) < 0 || idx >= NFREQ) continue;
        if ((k = find_or_add(r->obs, &nu, sat, t)) < 0) break;
        r->obs[k].code[idx] = c;
        r->obs[k].P[idx] = P[i];
        r->obs[k].L[idx] = L[i];
        r->obs[k].D[idx] = (float)D[i];
        r->obs[k].SNR[idx] = (uint16_t)(snr[i] / SNR_UNIT + 0.5);
        r->obs[k].LLI[idx] = (uint8_t)lli[i];
    }
    if (nu == 0) return -1;
    qsort(r->obs, nu, sizeof(obsd_t), cmp_sat);
    r->trov = t;

    /* rover (rcv=1) puis base (rcv=2) */
    nobs = nu;
    if (r->hasbase) {
        for (i = 0; i < r->nbase && nobs < MAXOBS * 2; i++) r->obs[nobs++] = r->base[i];
    }
    r->rtk.neb = 0;
    k = rtkpos(&r->rtk, r->obs, nobs, &r->rtcm.nav);
    i = r->rtk.neb < (int)sizeof(r->err) - 1 ? r->rtk.neb : (int)sizeof(r->err) - 1;
    memcpy(r->err, r->rtk.errbuf, i);
    r->err[i] = '\0';
    if (!k) return 0;

    sol_t *sol = &r->rtk.sol;
    if (sol->stat == SOLQ_NONE) return 0;
    ecef2pos(sol->rr, pos);
    /* covariance ECEF -> ENU */
    P3[0] = sol->qr[0]; P3[4] = sol->qr[1]; P3[8] = sol->qr[2];
    P3[1] = P3[3] = sol->qr[3]; P3[5] = P3[7] = sol->qr[4]; P3[2] = P3[6] = sol->qr[5];
    covenu(pos, P3, Q);

    out[FM_OUT_STAT] = sol->stat;
    out[FM_OUT_LAT] = pos[0] * R2D;
    out[FM_OUT_LON] = pos[1] * R2D;
    out[FM_OUT_HGT] = pos[2];
    out[FM_OUT_NSAT] = sol->ns;
    out[FM_OUT_AGE] = sol->age;
    out[FM_OUT_RATIO] = sol->ratio;
    out[FM_OUT_SDN] = sqrt(fabs(Q[4]));
    out[FM_OUT_SDE] = sqrt(fabs(Q[0]));
    out[FM_OUT_SDU] = sqrt(fabs(Q[8]));
    out[FM_OUT_X] = sol->rr[0]; out[FM_OUT_Y] = sol->rr[1]; out[FM_OUT_Z] = sol->rr[2];
    return sol->stat;
}

const char *fm_rtk_errmsg(const fm_rtk_t *r) { return r->err; }
