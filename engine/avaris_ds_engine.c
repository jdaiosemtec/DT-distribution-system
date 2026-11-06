/* Avaris DS engine driver (OWA EPANET 2.3, static).
   Usage: avaris_ds_engine <inp> <rpt> <out>
   Prints "PROGRESS <percent>" lines during the hydraulic run, then "DONE" or "ERROR <code> <message>". */
#include <stdio.h>
#include <string.h>
#include "epanet2_2.h"

static int fail(EN_Project ph, int err) {
    char msg[256] = ""; EN_geterror(err, msg, 255);
    printf("ERROR %d %s\n", err, msg); fflush(stdout);
    if (ph) { EN_close(ph); EN_deleteproject(ph); }
    return err > 100 ? 1 : 0;
}

int main(int argc, char *argv[]) {
    if (argc < 4) { printf("Usage: %s <inp> <rpt> <out>\n", argv[0]); return 2; }
    EN_Project ph = NULL; int err; long t = 0, tstep = 0, dur = 0; int last = -1; double d;
    EN_createproject(&ph);
    if ((err = EN_open(ph, argv[1], argv[2], argv[3])) > 100) return fail(ph, err);
    EN_gettimeparam(ph, EN_DURATION, &dur);
    if ((err = EN_openH(ph)) > 100) return fail(ph, err);
    if ((err = EN_initH(ph, EN_SAVE)) > 100) return fail(ph, err);
    do {
        if ((err = EN_runH(ph, &t)) > 100) return fail(ph, err);
        int p = dur > 0 ? (int)(90.0 * t / dur) : 90;
        if (p != last) { printf("PROGRESS %d\n", p); fflush(stdout); last = p; }
        if ((err = EN_nextH(ph, &tstep)) > 100) return fail(ph, err);
    } while (tstep > 0);
    EN_closeH(ph);
    if ((err = EN_solveQ(ph)) > 100) return fail(ph, err);
    printf("PROGRESS 95\n"); fflush(stdout);
    if ((err = EN_report(ph)) > 100) return fail(ph, err);
    EN_close(ph); EN_deleteproject(ph); (void)d;
    printf("PROGRESS 100\nDONE\n"); fflush(stdout);
    return 0;
}
