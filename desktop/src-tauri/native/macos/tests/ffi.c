/* Synthetic buffers only. Never enumerates/captures a real window or queries permission. */
#include "../include/neb_capture.h"
#include <assert.h>
#include <math.h>
#include <pthread.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
#include <CoreText/CoreText.h>

extern int32_t neb_capture_test_validation(void);
struct result { size_t calls, size; uint8_t *copy; uint32_t w,h,c; };
static void bytes(void *context, const uint8_t *p, size_t n, uint32_t w, uint32_t h, uint32_t c) {
    struct result *r = context;
    assert(p && n && n <= 16*1024*1024);
    r->calls++; r->size=n; r->w=w; r->h=h; r->c=c;
    r->copy=malloc(n+1); assert(r->copy); memcpy(r->copy,p,n); r->copy[n]=0;
}
static int32_t refuse(void *context) { (*(int *)context)++; return 0; }
static void dispose(struct result *r) {
    if (r->copy) { memset(r->copy,0,r->size+1); free(r->copy); }
    memset(r,0,sizeof(*r));
}
static void *worker(void *unused) {
    (void)unused;
    assert(neb_capture_test_validation()==0);
    struct result r={0};
    uint8_t tiny[4]={0,0,255,255};
    assert(neb_jpeg_encode(NULL,4,1,1,4,.8,bytes,&r)==NEB_INVALID);
    assert(neb_jpeg_encode(tiny,3,1,1,4,.8,bytes,&r)==NEB_INVALID);
    assert(neb_jpeg_encode(tiny,4,1,1,4,NAN,bytes,&r)==NEB_INVALID);
    assert(neb_jpeg_encode(tiny,4,UINT32_MAX,UINT32_MAX,4,.8,bytes,&r)==NEB_INVALID);
    assert(neb_jpeg_encode(tiny,4,1,1,4,1.01,bytes,&r)==NEB_INVALID);
    assert(neb_jpeg_encode(tiny,4,1,1,4,.8,NULL,&r)==NEB_INVALID);
    assert(neb_ocr_read(NULL,4,1,1,4,bytes,&r)==NEB_INVALID);
    assert(neb_ocr_read(tiny,4,1,1,3,bytes,&r)==NEB_INVALID);
    assert(neb_ocr_read(tiny,4,2561,1,1,bytes,&r)==NEB_INVALID);
    assert(!r.calls);
    int guards=0;
    assert(neb_capture_once(1,1,1,0,0,10,10,refuse,&guards,bytes,&r)==NEB_CANCELLED);
    assert(guards==1 && r.calls==0); /* returns before permission or native metadata */
    assert(neb_capture_once(0,1,1,0,0,10,10,refuse,&guards,bytes,&r)==NEB_INVALID);
    assert(neb_capture_once(1,1,1,0,0,NAN,10,refuse,&guards,bytes,&r)==NEB_INVALID);
    assert(guards==1 && r.calls==0);
    /* Synthetic solid-red BGR fixture verifies channel order through a real JPEG decoder. */
    uint8_t fixture[32*24*3];
    for(size_t i=0;i<sizeof(fixture);i+=3){ fixture[i]=0; fixture[i+1]=0; fixture[i+2]=255; }
    assert(neb_jpeg_encode(fixture,sizeof(fixture),32,24,3,.95,bytes,&r)==NEB_OK);
    assert(r.calls==1 && r.w==32 && r.h==24 && r.c==0);
    assert(r.copy[0]==0xff && r.copy[1]==0xd8);
    CFDataRef data=CFDataCreate(NULL,r.copy,r.size);
    CGImageSourceRef source=CGImageSourceCreateWithData(data,NULL); assert(source);
    CGImageRef image=CGImageSourceCreateImageAtIndex(source,0,NULL); assert(image);
    assert(CGImageGetWidth(image)==32 && CGImageGetHeight(image)==24);
    uint8_t decoded[32*24*4]={0};
    CGColorSpaceRef rgb=CGColorSpaceCreateDeviceRGB();
    CGContextRef cg=CGBitmapContextCreate(decoded,32,24,8,32*4,rgb,kCGImageAlphaPremultipliedLast);
    assert(cg); CGContextDrawImage(cg,CGRectMake(0,0,32,24),image);
    size_t mid=(12*32+16)*4;
    assert(decoded[mid]>240 && decoded[mid+1]<15 && decoded[mid+2]<15);
    CGContextRelease(cg); CGColorSpaceRelease(rgb); CGImageRelease(image);
    CFRelease(source); CFRelease(data); dispose(&r);
    uint8_t bgra[16*16*4]; memset(bgra,255,sizeof(bgra));
    assert(neb_jpeg_encode(bgra,sizeof(bgra),16,16,4,.8,bytes,&r)==NEB_OK);
    assert(r.calls==1 && r.size>0); dispose(&r);
    /* Vision sees only this generated all-white buffer. It may return empty lines. */
    uint8_t blank[64*64]; memset(blank,255,sizeof(blank));
    assert(neb_ocr_read(blank,sizeof(blank),64,64,1,bytes,&r)==NEB_OK);
    assert(r.calls==1 && strstr((char *)r.copy,"\"lines\"") && r.c==0); dispose(&r);
    /* Generated text verifies Vision result serialization, not just empty success. */
    uint8_t lettering[640*120*4]; memset(lettering,255,sizeof(lettering));
    rgb=CGColorSpaceCreateDeviceRGB();
    cg=CGBitmapContextCreate(lettering,640,120,8,640*4,rgb,
        kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst); assert(cg);
    CTFontRef font=CTFontCreateWithName(CFSTR("Helvetica"),36,NULL);
    CGFloat blackComponents[4]={0,0,0,1};
    CGColorRef black=CGColorCreate(rgb,blackComponents);
    const void *keys[]={kCTFontAttributeName,kCTForegroundColorAttributeName};
    const void *values[]={font,black};
    CFDictionaryRef attrs=CFDictionaryCreate(NULL,keys,values,2,
        &kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
    CFAttributedStringRef text=CFAttributedStringCreate(NULL,CFSTR("Neb synthetic OCR 4286"),attrs);
    CTLineRef line=CTLineCreateWithAttributedString(text);
    CGContextSetTextPosition(cg,20,45); CTLineDraw(line,cg);
    CFRelease(line); CFRelease(text); CFRelease(attrs); CFRelease(font);
    CGColorRelease(black); CGContextRelease(cg); CGColorSpaceRelease(rgb);
    assert(neb_ocr_read(lettering,sizeof(lettering),640,120,4,bytes,&r)==NEB_OK);
    assert(r.calls==1 && strstr((char *)r.copy,"4286")); dispose(&r);
    memset(lettering,0,sizeof(lettering));
    return NULL;
}
int main(void) {
    struct result r={0}; uint8_t tiny[4]={0};
    assert(neb_jpeg_encode(tiny,4,1,1,4,.8,bytes,&r)==NEB_BUSY);
    assert(neb_ocr_read(tiny,4,1,1,4,bytes,&r)==NEB_BUSY);
    assert(neb_capture_once(1,1,1,0,0,1,1,NULL,NULL,bytes,&r)==NEB_BUSY);
    pthread_t thread; assert(!pthread_create(&thread,NULL,worker,NULL));
    assert(!pthread_join(thread,NULL));
    puts("Native capture bridge: synthetic FFI, JPEG decode and Vision OCR tests passed; no screen captured.");
    return 0;
}
