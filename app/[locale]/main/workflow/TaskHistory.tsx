import { VirtualList } from '@/components/VirtualList'
import { trpc } from '@/utils/trpc'
import { TaskItem } from './TaskItem'

export const TaskHistory: IComponent = () => {
  const tasker = trpc.workflowTask.list.useInfiniteQuery(
    {
      limit: 10
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor
    }
  )

  trpc.watch.historyList.useSubscription(undefined, {
    onData: () => tasker.refetch()
  })

  const allRows = tasker.data ? tasker.data.pages.flatMap((d) => d.items).reverse() : []

  return (
    <VirtualList
      onFetchMore={tasker.fetchNextPage}
      hasNextPage={tasker.hasNextPage}
      isFetchingNextPage={tasker.isFetchingNextPage}
      items={allRows}
      style={{
        position: 'absolute',
        top: 0,
        width: '100%',
        height: '100%',
        boxShadow: 'inset 0 0 10px 0 rgba(0, 0, 0, 0.1)'
      }}
      getItemKey={(item) => {
        return item.id
      }}
      estimateSize={() => 130}
      renderItem={(item) => {
        return <TaskItem data={item} />
      }}
      overscan={5}
    />
  )
}
