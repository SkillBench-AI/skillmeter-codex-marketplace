// Synthetic local adapter: actual EventProcessor and PromptStore, with an
// API-Gateway-shaped request. AWS credentials and endpoint must be test-only.
package main

import (
 "context"
 "encoding/base64"
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "net"
 "net/http"
 "os"
 "strings"
 "sync"

 "github.com/aws/aws-lambda-go/events"
 "github.com/skillbench/skillmeter-lambda/handler"
 "github.com/skillbench/skillmeter-lambda/storage"
)
func main() {
 if !strings.HasPrefix(os.Getenv("AWS_ENDPOINT_URL_S3"), "http://127.0.0.1:") || os.Getenv("AWS_ACCESS_KEY_ID") != "testing" { panic("synthetic localhost S3 required") }
 store, err := storage.NewPromptStore(context.Background()); if err != nil { panic(err) }
 processor := handler.NewEventProcessor(nil, store)
 listener, err := net.Listen("tcp", "127.0.0.1:0"); if err != nil { panic(err) }
 var mutex sync.Mutex
 dropped := false
 server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter,r *http.Request) {
   mutex.Lock(); defer mutex.Unlock()
   body, err := io.ReadAll(io.LimitReader(r.Body, 6*1024*1024)); if err != nil { http.Error(w,"read",500);return }
   headers:=map[string]string{};for key, values:=range r.Header { headers[strings.ToLower(key)]=values[0] }
   req:=events.APIGatewayV2HTTPRequest{Headers:headers,Body:base64.StdEncoding.EncodeToString(body),IsBase64Encoded:true}
   req.RequestContext.HTTP.Path=r.URL.Path
   if err:=processor.ProcessTranscript(r.Context(),req);err!=nil { var he *handler.HTTPError;code:=500;if errors.As(err,&he){code=he.Status};http.Error(w,err.Error(),code);return }
   // Simulate response loss AFTER the real conditional S3 write committed.
   if !dropped { dropped=true;conn,_,err:=w.(http.Hijacker).Hijack();if err==nil{conn.Close()};return }
   w.WriteHeader(200);fmt.Fprint(w,`{"ok":true}`)
 })}
 json.NewEncoder(os.Stdout).Encode(map[string]string{"url":"http://"+listener.Addr().String()+"/logs/codex"})
 if err:=server.Serve(listener);err!=nil{panic(err)}
}
