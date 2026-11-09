cmake_minimum_required(VERSION 3.22)
project(fmrtk C)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# RTKLIB demo5 (rtklibexplorer, licence BSD-2), version figée.
# Pour compiler hors ligne : -DRTKLIB_DIR=/chemin/vers/RTKLIB
if(NOT RTKLIB_DIR)
  include(FetchContent)
  FetchContent_Declare(rtklib
    URL https://github.com/rtklibexplorer/RTKLIB/archive/refs/tags/b34k.tar.gz)
  FetchContent_GetProperties(rtklib)
  if(NOT rtklib_POPULATED)
    FetchContent_Populate(rtklib)
  endif()
  set(RTKLIB_DIR ${rtklib_SOURCE_DIR})
endif()

set(RTK ${RTKLIB_DIR}/src)
set(RTK_SOURCES
  ${RTK}/rtkcmn.c ${RTK}/rtkpos.c ${RTK}/rtcm.c ${RTK}/rtcm2.c ${RTK}/rtcm3.c
  ${RTK}/rtcm3e.c ${RTK}/ephemeris.c ${RTK}/preceph.c ${RTK}/sbas.c ${RTK}/ionex.c
  ${RTK}/lambda.c ${RTK}/pntpos.c ${RTK}/ppp.c ${RTK}/ppp_ar.c ${RTK}/tides.c
  ${RTK}/solution.c ${RTK}/trace.c ${RTK}/rinex.c ${RTK}/geoid.c ${RTK}/datum.c)

add_library(rtklib STATIC ${RTK_SOURCES})
target_include_directories(rtklib PUBLIC ${RTK})
# ENAGLO..ENAIRN : constellations ; NFREQ=3 : L1/L2/L5 ; pas de tracé ni de LAPACK
target_compile_definitions(rtklib PUBLIC ENAGLO ENAGAL ENACMP ENAQZS NFREQ=3 NEXOBS=0)
target_compile_options(rtklib PRIVATE -w -O2)
if(NOT ANDROID)
  target_link_libraries(rtklib PUBLIC m pthread)
endif()

add_library(fmcore STATIC fm_rtk.c)
target_link_libraries(fmcore PUBLIC rtklib)
target_compile_options(fmcore PRIVATE -Wall -O2)

if(ANDROID)
  add_library(fmrtk SHARED fm_jni.c)
  target_link_libraries(fmrtk fmcore log m)
else()
  # Sur PC : test de bout en bout + vérification que la lib JNI se lie sans symbole manquant
  find_package(JNI)
  if(JNI_FOUND)
    add_library(fmrtk SHARED fm_jni.c)
    target_include_directories(fmrtk PRIVATE ${JNI_INCLUDE_DIRS})
    target_link_libraries(fmrtk fmcore)
    target_link_options(fmrtk PRIVATE -Wl,--no-undefined)
  endif()
  enable_testing()
  add_executable(test_bridge test/test_bridge.c)
  target_link_libraries(test_bridge fmcore)
  add_test(NAME bridge COMMAND test_bridge ${RTKLIB_DIR}/test/data/rinex)
endif()
