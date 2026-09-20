sub Main(args as Dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)
    scene = screen.CreateScene("MainScene")
    if args <> invalid and args.contentId <> invalid then scene.contentUrl = args.contentId
    screen.Show()

    input = CreateObject("roInput")
    input.SetMessagePort(port)
    while true
        message = wait(0, port)
        if type(message) = "roSGScreenEvent" and message.IsScreenClosed() then return
        if type(message) = "roInputEvent" then scene.inputCommand = message.GetInfo()
    end while
end sub

